const express = require('express');
const router = express.Router();
const xml2js = require('xml2js');
const pause = require('connect-pause');
const Service = require('../models/Service');

// function for registering an RR pair on a service
function registerRRPair(service, rrpair) {
  let path;
  let matched;

  if (rrpair.path) path = service.basePath + rrpair.path;
  else path = service.basePath;

  // set default response delay to 1 ms
  if (!service.delay) service.delay = 1;

  router.all(path, pause(service.delay), function(req, resp, next) {
    if (req.method === rrpair.verb) {
      // convert xml to js object
      if (rrpair.payloadType === 'XML') {
        xml2js.parseString(req.body, function(err, xmlReq) {
          matched = matchRequest(xmlReq, next);
        });
      }
      else {
        matched = matchRequest(req.body, next);
      }
    }
    else {
      console.log("methods don't match");
      return next();
    }
    console.log("Service matched: " + matched);

    // bump txn count
    if (!service.hasOwnProperty('txnCount')) service.txnCount = 0;
    service.txnCount++;
    service.save(function(err) {
      if (err) console.error('Error saving service: ' + err);
    });
    
    // run next callback if request not matched
    if (!matched) return next();

    // function for matching requests
    function matchRequest(payload, next) {
      let reqData;
      let resData;
      const isGet = req.method === 'GET';

      if (!isGet) {
        if (rrpair.payloadType === 'XML') {
          xml2js.parseString(rrpair.reqData, {'async': false}, function(err, data) {
            reqData = data;
          });
        }
        else {
          reqData = rrpair.reqData;
        }
      }

      if (isGet || compareObjects(payload, reqData)) {
        // check request queries
        if (rrpair.queries) {
          // try the next rr pair if no queries were sent
          if (!req.query) {
            console.log("expected query in request");
            return false;
          }

          // try the next rr pair if queries do not match
          if (!compareObjects(rrpair.queries, req.query)) {
            console.log("expected query: " + JSON.stringify(rrpair.queries));
            console.log("received query: " + JSON.stringify(req.query));
            return false;
          }
        }

        // check request headers
        if (rrpair.reqHeaders) {
          let matchedHeaders = true;
          const expectedHeaders = Object.entries(rrpair.reqHeaders);

          expectedHeaders.forEach(function(keyVal) {
            const sentVal = req.get(keyVal[0]);
            // try the next rr pair if headers do not match
            if (sentVal !== keyVal[1]) {
              matchedHeaders = false;
              console.log('expected header: ' + keyVal[0] + ': ' + keyVal[1]);
              console.log('received header: ' + keyVal[0] + ': ' + sentVal);
            }
          });

          if (!matchedHeaders) return false;
        }

        // send matched data back to client
        setRespHeaders();
        if (!rrpair.resStatus)
          resp.send(rrpair.resData);
        else
          resp.status(rrpair.resStatus).send(rrpair.resData);

        return true;
      }

      console.log("expected payload: " + JSON.stringify(reqData, null, 2));
      console.log("received payload: " + JSON.stringify(payload, null, 2));
      return false;

      function flattenObject(ob) {
          const toReturn = {};
          for (const i in ob) {
              if (!ob.hasOwnProperty(i)) continue;

              if ((typeof ob[i]) == 'object') {
                  const flatObject = flattenObject(ob[i]);
                  for (const x in flatObject) {
                      if (!flatObject.hasOwnProperty(x)) continue;

                      toReturn[i + '.' + x] = flatObject[x];
                  }
              } else {
                  toReturn[i] = ob[i];
              }
          }
          return toReturn;
      }

      function compareObjects(obj1, obj2) {
        // flatten and sort keys so order doesn't impact matching
        const keysVals1 = Object.entries(flattenObject(obj1)).sort();
        const keysVals2 = Object.entries(flattenObject(obj2)).sort();

        return (JSON.stringify(keysVals1) === JSON.stringify(keysVals2));
      }

      function setRespHeaders() {
        const resHeaders = rrpair.resHeaders;

        if (!resHeaders) {
          // set default headers
          if (rrpair.payloadType === 'XML')
            resp.set("Content-Type", "text/xml");
          else {
            resp.set("Content-Type", "application/json");
          }
        }
        else {
          resp.set(resHeaders);
        }
      }
    }
  });
}

// register all RR pairs for all SOAP / REST services from db
function registerAllRRPairsForAllServices() {
  Service.find({ $or: [{ type:'SOAP' }, { type:'REST' }] }, function(err, services) {
    if (err) {
      console.error('Error registering services: ' + err);
      return;
    }

    try {
      services.forEach(function(service){
        service.rrpairs.forEach(function(rrpair){
          registerRRPair(service, rrpair);
        });
      });
    }
    catch(e) {
      console.error('Error registering services: ' + e);
    }
  });
}

module.exports = {
  router: router,
  registerRRPair: registerRRPair,
  registerAllRRPairsForAllServices: registerAllRRPairsForAllServices
};
