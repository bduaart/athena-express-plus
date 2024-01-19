"use strict";
//helpers.js

const { GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } = require("@aws-sdk/client-athena");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const csv = require("csvtojson");
const readline = require("readline");

function startQueryExecution(config) {
  const params = {
    QueryString: config.sql,
    WorkGroup: config.workgroup,
    ResultConfiguration: {},
    QueryExecutionContext: {
      Database: config.db,
      Catalog: config.catalog,
    },
  };
  if(config.s3Bucket){
    params.ResultConfiguration.OutputLocation = config.s3Bucket;
  }
  if(config.values && config.values.length > 0)
    params.ExecutionParameters = config.values;
  if (config.encryption)
    params.ResultConfiguration.EncryptionConfiguration = config.encryption;

  return new Promise(function (resolve, reject) {
    const startQueryExecutionRecursively = async function () {
      try {
        const data = await config.athena.send(new StartQueryExecutionCommand(params));
        resolve(data.QueryExecutionId);
      } catch (err) {
        isCommonAthenaError(err.code)
          ? setTimeout(() => {
              startQueryExecutionRecursively();
            }, 2000)
          : reject(err);
      }
    };
    startQueryExecutionRecursively();
  });
}

function checkIfExecutionCompleted(config) {
  let retry = config.retry;
  return new Promise(function (resolve, reject) {
    const keepCheckingRecursively = async function () {
      try {
        const data = await config.athena.send(new GetQueryExecutionCommand({
          QueryExecutionId: config.QueryExecutionId,
        }));
        if (data.QueryExecution.Status.State === "SUCCEEDED") {
          retry = config.retry;
          resolve(data);
        } else if (data.QueryExecution.Status.State === "FAILED" ||
            data.QueryExecution.Status.State === "CANCELLED") {
          reject(data.QueryExecution.Status.StateChangeReason);
        } else {
          setTimeout(() => {
            keepCheckingRecursively();
          }, retry);
        }
      } catch (err) {
        if (isCommonAthenaError(err.code)) {
          retry = 2000;
          setTimeout(() => {
            keepCheckingRecursively();
          }, retry);
        } else reject(err);
      }
    };
    keepCheckingRecursively();
  });
}

async function getQueryResultsFromS3(params) {
  const s3Params = {
    Bucket: params.s3Output.split("/")[2],
    Key: params.s3Output.split("/").slice(3).join("/"),
  };

  if (params.statementType === "UTILITY" || params.statementType === "DDL") {
    const input = await params.config.s3.send(new GetObjectCommand(s3Params));
    return { items: await cleanUpNonDML(input.Body) };
  } else if (Boolean(params.config.pagination)) {
    //user wants DML response paginated

    const paginationFactor = Boolean(params.config.NextToken) ? 0 : 1;

    let paginationParams = {
      QueryExecutionId: params.config.QueryExecutionId,
      MaxResults: params.config.pagination + paginationFactor,
      NextToken: params.config.NextToken,
    };


    const queryResults = await params.config.athena.send(new GetQueryResultsCommand(
      paginationParams
    ));
    if (params.config.formatJson) {
      return {
        items: await cleanUpPaginatedDML(queryResults, paginationFactor, params.config),
        nextToken: queryResults.NextToken,
      };
    } else {
      return {
        items: await queryResults,
        nextToken: queryResults.NextToken,
      };
    }
  } else {
    //user doesn't want DML response paginated
    const input = await params.config.s3.send(new GetObjectCommand(s3Params));
    if (params.config.formatJson) {
      return {
        items: await cleanUpDML(input.Body, params.config),
      };
    } else {
      return { items: await getRawResultsFromS3(input.Body) };
    }
  }
}

async function cleanUpPaginatedDML(queryResults, paginationFactor, params) {
  const dataTypes = await getDataTypes(params);
  const columnNames = Object.keys(dataTypes).reverse();
  let rowObject = {};
  let unformattedS3RowArray = null;
  let formattedArray = [];

  for (let i = paginationFactor; i < queryResults.ResultSet.Rows.length; i++) {
    unformattedS3RowArray = queryResults.ResultSet.Rows[i].Data;

    for (let j = 0; j < unformattedS3RowArray.length; j++) {
      if (unformattedS3RowArray[j].hasOwnProperty("VarCharValue")) {
        [rowObject[columnNames[j]]] = [unformattedS3RowArray[j].VarCharValue];
      }
    }

    formattedArray.push(addDataType(rowObject, dataTypes));
    rowObject = {};
  }
  return formattedArray;
}

function getRawResultsFromS3(input) {
  let rawJson = [];
  return new Promise(function (resolve, reject) {
    readline
      .createInterface({
        input,
      })
      .on("line", (line) => {
        rawJson.push(line.trim());
      })
      .on("close", function () {
        resolve(rawJson);
      });
  });
}

function getDataTypes(config) {
  return new Promise(async function (resolve) {
    const s3Metadata = config.athena.send(new GetQueryResultsCommand({
      QueryExecutionId: config.QueryExecutionId,
      MaxResults: 1,
    }));
    const columnInfoArray = (await s3Metadata).ResultSet.ResultSetMetadata
      .ColumnInfo;
    let columnInfoArrayLength = columnInfoArray.length;
    let columnInfoObject = {};
    while (columnInfoArrayLength--) {
      [columnInfoObject[columnInfoArray[columnInfoArrayLength].Name]] = [
        columnInfoArray[columnInfoArrayLength].Type,
      ];
    }
    resolve(columnInfoObject);
  });
}

async function cleanUpDML(input, params) {
  let cleanJson = [];
  const dataTypes = await getDataTypes(params);
  return new Promise(function (resolve) {
    input.pipe(
      csv({
        ignoreEmpty: params.ignoreEmpty,
        flatKeys: params.flatKeys
      })
        .on("data", (data) => {
          cleanJson.push(
            addDataType(JSON.parse(data.toString("utf8")), dataTypes)
          );
        })
        .on("finish", function () {
          resolve(cleanJson);
        })
    );
  });
}

function addDataType(input, dataTypes) {
  let updatedObjectWithDataType = {};

  for (const key in input) {
    if (!input[key]) {
      updatedObjectWithDataType[key] = null;
    } else {
      switch (dataTypes[key]) {
        case "varchar":
          updatedObjectWithDataType[key] = input[key];
          break;
        case "boolean":
          updatedObjectWithDataType[key] = JSON.parse(input[key].toLowerCase());
          break;
        case "bigint":
          updatedObjectWithDataType[key] = BigInt(input[key]);
          break;
        case "integer":
        case "tinyint":
        case "smallint":
        case "int":
        case "float":
        case "double":
          updatedObjectWithDataType[key] = Number(input[key]);
          break;
        default:
          updatedObjectWithDataType[key] = input[key];
      }
    }
  }
  return updatedObjectWithDataType;
}

function cleanUpNonDML(input) {
  let cleanJson = [];
  return new Promise(function (resolve) {
    readline
      .createInterface({
        input,
      })
      .on("line", (line) => {
        switch (true) {
          case line.indexOf("\t") > 0:
            line = line.split("\t");
            cleanJson.push({
              [line[0].trim()]: line[1].trim(),
            });
            break;
          default:
            if (line.trim().length) {
              cleanJson.push({
                row: line.trim(),
              });
            }
        }
      })
      .on("close", function () {
        resolve(cleanJson);
      });
  });
}

function validateConstructor(init) {
  if (!init) {
    throw new TypeError("Config object not present in the constructor");
  }
  const { athena, s3 } = init;
  if (!athena || !s3) {
    throw new TypeError("athena, s3 are required in the config object");
  }
}

function isCommonAthenaError(err) {
  return err === "TooManyRequestsException" ||
    err === "ThrottlingException" ||
    err === "NetworkingError" ||
    err === "UnknownEndpoint"
    ? true
    : false;
}

const lowerCaseKeys = (obj) =>
  Object.keys(obj).reduce((acc, key) => {
    if (obj[key] !== undefined) {
      acc[key.toLowerCase()] = obj[key];
    }
    return acc;
  }, {});

module.exports = {
  validateConstructor,
  startQueryExecution,
  checkIfExecutionCompleted,
  getQueryResultsFromS3,
  lowerCaseKeys,
};
