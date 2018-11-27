const Service = require('../models/Service');
const RRPair = require('../models/RRPair');
const virtual = require('../routes/virtual');
const manager = require('../lib/pm2/manager');
const debug = require('debug')('default');
const oas = require('../lib/openapi/parser');
const wsdl = require('../lib/wsdl/parser');
const rrpair = require('../lib/rrpair/parser');
const request = require('request');
const fs   = require('fs');
const unzip = require('unzip2');
const YAML = require('yamljs');

function getServiceById(req, res) {
  // call find by id function for db
  Service.findById(req.params.id, function (err, service) {
    if (err) {
      handleError(err, res, 500);
      return;
    }

    res.json(service);
  });
}

function getServicesByUser(req, res) {
  Service.find({ 'user.uid': req.params.uid }, function (err, services) {
    if (err) {
      handleError(err, res, 500);
      return;
    }

    res.json(services);
  });
}

function getServicesBySystem(req, res) {
  Service.find({ 'sut.name': req.params.name }, function (err, services) {
    if (err) {
      handleError(err, res, 500);
      return;
    }

    res.json(services);
  });
}

function getServicesByQuery(req, res) {
  const query = {
    'sut.name': req.query.sut,
    'user.uid': req.query.user
  };

  // call find function with queries
  Service.find(query, function (err, services) {
    if (err) {
      handleError(err, res, 500);
      return;
    }

    res.json(services);
  });
}

// function to check for duplicate service & twoSeviceDiffNameSameBasePath
function searchDuplicate(service, next) {
  const query2ServDiffNmSmBP = {
    name: { $ne: service.name },
    basePath: service.basePath
  };

  const query = {
    name: service.name,
    basePath: service.basePath
  };

  Service.findOne(query2ServDiffNmSmBP, function (err, sameNmDupBP) {
    if (err) {
      handleError(err, res, 500);
      return;
    }
    else if (sameNmDupBP)
      next({ twoServDiffNmSmBP: true });
    else {
      Service.findOne(query, function (err, duplicate) {
        if (err) {
          handleError(err, res, 500);
          return;
        }
        next(duplicate);
      });
    }
  });
}

// returns a stripped-down version on the rrpair for logical comparison
function stripRRPair(rrpair) {
  return {
    verb: rrpair.verb || '',
    path: rrpair.path || '',
    payloadType: rrpair.payloadType || '',
    queries: rrpair.queries || {},
    reqHeaders: rrpair.reqHeaders || {},
    reqData: rrpair.reqData || {},
    resStatus: rrpair.resStatus || 200,
    resHeaders: rrpair.resHeaders || {},
    resData: rrpair.resData || {}
  };
}

// function to merge req / res pairs of duplicate services
function mergeRRPairs(original, second) {
  for (let rrpair2 of second.rrpairs) {
    let hasAlready = false;
    let rr2 = stripRRPair(new RRPair(rrpair2));

    for (let rrpair1 of original.rrpairs) {
      let rr1 = stripRRPair(rrpair1);

      if (deepEquals(rr1, rr2)) {
        hasAlready = true;
        break;
      }
    }

    // only add RR pairs that original doesn't have already
    if (!hasAlready) {
      original.rrpairs.push(rrpair2);
    }
  }
}

// propagate changes to all threads
function syncWorkers(service, action) {
  const msg = {
    action: action,
    service: service
  };

  manager.messageAll(msg)
    .then(function (workerIds) {
      //if (workerIds.length) debug(workerIds);

      virtual.deregisterService(service);

      if (action === 'register') {
        virtual.registerService(service);
      }
      else {
        Service.findOneAndRemove({_id : service._id }, function(err)	{
          if (err) debug(err);
        });
      }
    })
    .catch(function (err) {
      debug(err);
    });
}

function addService(req, res) {
  let serv = {
    sut: req.body.sut,
    user: req.decoded,
    name: req.body.name,
    type: req.body.type,
    delay: req.body.delay,
    delayMax: req.body.delayMax,
    basePath: '/' + req.body.sut.name + req.body.basePath,
    matchTemplates: req.body.matchTemplates,
    rrpairs: req.body.rrpairs
    
  };

  searchDuplicate(serv, function (duplicate) {
    if (duplicate && duplicate.twoServDiffNmSmBP) {
      res.json({ "error": "twoSeviceDiffNameSameBasePath" });
      return;
    }
    else if (duplicate) {
      // merge services
      mergeRRPairs(duplicate, serv);
      // save merged service
      duplicate.save(function (err, newService) {
        if (err) {
          handleError(err, res, 500);
          return;
        }
        res.json(newService);
        syncWorkers(newService, 'register');
      });
    }
    else {
      Service.create(serv,
        // handler for db call
        function (err, service) {
          if (err) {
            handleError(err, res, 500);
            return;
          }
          // respond with the newly created resource
          res.json(service);
        syncWorkers(service, 'register');
        });
    }
  });
}

function updateService(req, res) {
  // find service by ID and update
  Service.findById(req.params.id, function (err, service) {
    if (err) {
      handleError(err, res, 400);
      return;
    }

    // don't let consumer alter name, base path, etc.
    service.rrpairs = req.body.rrpairs;

    if (req.body.matchTemplates) {
      service.matchTemplates = req.body.matchTemplates;
    }
    
    const delay = req.body.delay;
    if (delay || delay === 0) {
      service.delay = req.body.delay;
    }

    const delayMax = req.body.delayMax;
    if (delayMax || delayMax === 0) {
      service.delayMax = req.body.delayMax;
    }
    // save updated service in DB
    service.save(function (err, newService) {
      if (err) {
        handleError(err, res, 500);
        return;
      }

      res.json(newService);
      syncWorkers(newService, 'register');
    });
  });
}

function toggleService(req, res) {
  Service.findById(req.params.id, function (err, service) {
    if (err) {
      handleError(err, res, 500);
      return;
    }

    // flip the bit & save in DB
    service.running = !service.running;
    service.save(function (e, newService) {
      if (e) {
        handleError(e, res, 500);
        return;
      }

      res.json({ 'message': 'toggled', 'service': newService });
      syncWorkers(newService, 'register');
    });
  });
}

function deleteService(req, res) {
  Service.findById(req.params.id, function(err, service)	{
    if (err)	{
      handleError(err, res, 500);
      return;
}

    service.remove(function(e, oldService) {
      if (e)	{
        handleError(e, res, 500);
        return;
      }

      res.json({ 'message' : 'deleted', 'id' : oldService._id });
      syncWorkers(oldService, 'delete');
    });
  });
}

// get spec from url or local filesystem path
function getSpecString(path) {
  return new Promise(function (resolve, reject) {
    if (path.includes('http')) {
      request(path, function (err, resp, data) {
        if (err) return reject(err);
        return resolve(data);
      });
    }
    else {
      fs.readFile(path, 'utf8', function (err, data) {
        if (err) return reject(err);
        return resolve(data);
      });
    }
  });

}

function isYaml(req) {
  const url = req.query.url;
  if (url) {
    if (url.includes('yml') || url.includes('yaml'))
      return true;
  }
  if (req.file) {
    const name = req.file.originalname;
    if (name.includes('yml') || name.includes('yaml')) {
      return true;
    }
  }
  return false;
}

function zipUploadAndExtract(req, res) {
  let extractZip = function () {
    return new Promise(function (resolve, reject) {
      fs.createReadStream(req.file.path).pipe(unzip.Extract({ path: '.\\RRPair\\' + req.decoded.uid + '_' + req.file.filename + '_' + req.file.originalname }));
      resolve('_' + req.file.filename + '_' + req.file.originalname);
    });
  }
  extractZip().then(function (message) {
    res.json(message);
  }).catch(function (err) {
    debug(err);
    handleError(err, res, 400);
  });
}

function publishExtractedRRPairs(req, res) {
  const type = req.query.type;
  const base = req.query.url;
  const name = req.query.name;
  const sut = { name: req.query.group };
  rrpair.parse('./RRPair/' + req.decoded.uid + req.query.uploaded_file_name_id).then(onSuccess).catch(onError);
  function onSuccess(serv) {
    serv.sut = sut;
    serv.name = name;
    serv.type = type;
    serv.basePath = '/' + serv.sut.name +'/'+ base;
    serv.user = req.decoded;
    Service.create(serv, function (err, service) {
      if (err) {
        handleError(err, res, 500);
      }
      res.json(service);
      syncWorkers(service._id, 'register');
    });
  }
  function onError(err) {
    debug(err);
    handleError(err, res, 400);
  }
}

function createFromSpec(req, res) {
  const type = req.query.type;
  const name = req.query.name;
  const url = req.query.url;
  const sut = { name: req.query.group };
  const specPath = url || req.file.path;

  switch (type) {
    case 'wsdl':
      createFromWSDL(specPath).then(onSuccess).catch(onError);
      break;
    case 'openapi':
      const specPromise = getSpecString(specPath);
      specPromise.then(function (specStr) {
        let spec;
        try {
          if (isYaml(req)) {
            spec = YAML.parse(specStr);
          }
          else {
            spec = JSON.parse(specStr);
          }
        }
        catch (e) {
          debug(e);
          return handleError('Error parsing OpenAPI spec', res, 400);
        }

        createFromOpenAPI(spec).then(onSuccess).catch(onError);

      }).catch(onError);
      break;
    default:
      return handleError(`API specification type ${type} is not supported`, res, 400);
  }

  function onSuccess(serv) {
    // set group, basePath, and owner
    serv.sut = sut;
    serv.name = name;
    serv.basePath = '/' + serv.sut.name + serv.basePath;
    serv.user = req.decoded;

    // save the service
    Service.create(serv, function (err, service) {
      if (err) handleError(err, res, 500);

      res.json(service);
      syncWorkers(service, 'register');
    });
  }

  function onError(err) {
    debug(err);
    handleError(err, res, 400);
  }
}

function createFromWSDL(file) {
  return wsdl.parse(file);
}

function createFromOpenAPI(spec) {
  return new Promise(function (resolve, reject) {
    return resolve(oas.parse(spec));
  });
}

module.exports = {
  getServiceById: getServiceById,
  getServicesByUser: getServicesByUser,
  getServicesBySystem: getServicesBySystem,
  getServicesByQuery: getServicesByQuery,
  addService: addService,
  updateService: updateService,
  toggleService: toggleService,
  deleteService: deleteService,
  createFromSpec: createFromSpec,
  zipUploadAndExtract: zipUploadAndExtract,
  publishExtractedRRPairs: publishExtractedRRPairs
};