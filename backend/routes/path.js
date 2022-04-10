/* eslint-disable guard-for-in */
/* eslint-disable no-restricted-syntax */
// eslint-disable-next-line import/no-import-module-exports

const express = require("express");
const queryOverpass = require("query-overpass");
const geolib = require("geolib");
const geohash = require("ngeohash");
const haversine = require("haversine");
const HashMap = require("hashmap");
const PriorityQueue = require("priorityqueuejs");
const Queue = require("@stdlib/utils-fifo");

const router = express.Router();

// returns bounding box of a given start/end point
const getExpandedBounds = (lat1, long1, lat2, long2) => {
  // NW
  // let westLat, eastLat, southLong, northLong;
  // if (lat1 > lat2) {
  //   westLat = lat1
  //   eastLat = lat2
  // } else {
  //   westLat = lat2
  //   eastLat = lat1
  // }
  // if (long1 > long2) {
  //   southLong = long1
  //   northLong = long2
  // } else {
  //   southLong = long2
  //   northLong = long1
  // }
  // westLat += 0.01
  // eastLat -= 0.01
  // southLong += 0.01
  // northLong -= 0.01
  // return [westLat, southLong, eastLat, northLong]
  // ADD ALL HEMISPHERE LATER
  //
  // call getBounds to return min/max lat/long for bounding box
  const bounds = geolib.getBounds([
    {
      latitude: lat1,
      longitude: long1,
    },
    {
      latitude: lat2,
      longitude: long2,
    },
  ]);
  return [
    // increase bounds by 0.01 degrees = 1.11 km
    bounds.minLat - 0.01,
    bounds.minLng - 0.01,
    bounds.maxLat + 0.01,
    bounds.maxLng + 0.01,
  ];
};

// returns all paths within bounding box (including unsafe roads)
const getAllPathsGeoJSON = (bounds) => {
  const query = `
  /*
  This shows the cycleway and cycleroute network.
  */
  
  [out:json];
  
  (
    // get cycle route relations
    relation[route=bicycle](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    // get cycleways
    way[cycleway=lane](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[cycleway=track](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=cycleway](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=path][bicycle=designated](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=path][bicycle=yes](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=footway][bicycle=designated](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=footway][bicycle=yes](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=living_street][bicycle=yes](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=residential][bicycle!=no](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    
    
    // unsafe
    way[highway=secondary][bicycle!=no](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=secondary_link][bicycle!=no](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=tertiary][bicycle!=no](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=tertiary_link][bicycle!=no](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=track][bicycle!=no](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=service][bicycle!=no](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
  );
  
  out body;
  >;
  out skel qt;
  `;
  return new Promise((resolve, reject) => {
    queryOverpass(query, (err, data) => {
      if (err) {
        reject(err);
      }
      resolve(data);
    });
  });
};

// returns cycling paths within bounding box (excluding unsafe roads)
const getBikePathsGeoJSON = async (bounds) => {
  const query = `
  /*
  This shows the cycleway and cycleroute network.
  */
  
  [out:json];
  
  (
    // get cycle route relations
    relation[route=bicycle](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    // get cycleways
    way[cycleway=lane](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[cycleway=track](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=cycleway](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=path][bicycle=designated](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=path][bicycle=yes](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=footway][bicycle=designated](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=footway][bicycle=yes](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=residential][bicycle!=no](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
    way[highway=living_street][bicycle!=no](${bounds[0]}, ${bounds[1]}, ${bounds[2]}, ${bounds[3]});
  );
  
  out body;
  >;
  out skel qt;
  `;
  return new Promise((resolve, reject) => {
    queryOverpass(query, (err, data) => {
      if (err) {
        reject(err);
      }
      resolve(data);
    });
  });
};

// builds graph from .geojson data
const buildGraph = (data) => {
  const graph = new HashMap();
  // iterate over all objects in features
  for (const f of data.features) {
    const feature = f.geometry; // geometry object that holds coordinates array
    // iterate over coordinates array
    for (let i = 0; i < feature.coordinates.length; i += 1) {
      const coordinate = feature.coordinates[i];
      const long = coordinate[0];
      const lat = coordinate[1];
      const id = geohash.encode(lat, long, 9);
      // create new node in graph
      graph.set(
        id,
        graph.has(id)
          ? graph.get(id)
          : {
              lat,
              long,
              adj: [],
            }
      );
      // find adjacent nodes, add to adj array
      if (i > 0) {
        const prevCoordinate = feature.coordinates[i - 1];
        const prevLat = prevCoordinate[1];
        const prevLong = prevCoordinate[0];
        const prevId = geohash.encode(prevCoordinate[1], prevCoordinate[0], 9);
        graph.get(id).adj.push({
          id: prevId,
          weight: haversine(
            { latitude: lat, longitude: long },
            { latitude: prevLat, longitude: prevLong }
          ),
        });
      }
      if (i < feature.coordinates.length - 1) {
        const nextCoordinate = feature.coordinates[i + 1];
        const nextLat = nextCoordinate[1];
        const nextLong = nextCoordinate[0];
        const nextId = geohash.encode(nextCoordinate[1], nextCoordinate[0], 9);
        graph.get(id).adj.push({
          id: nextId,
          weight: haversine(
            { latitude: lat, longitude: long },
            { latitude: nextLat, longitude: nextLong }
          ),
        });
      }
    }
  }
  return graph;
};

const reduceSafeWeights = (start, allPaths, bikePaths) => {
  const q = new Queue();
  const visited = new HashMap();
  q.push(start);
  while (q.length > 0) {
    const id = q.pop();
    const cur = allPaths.get(id);
    for (const v of cur.adj) {
      if (bikePaths.has(id) && bikePaths.has(v.id)) {
        cur.weight *= 0.75;
        if (cur.weight < 0) {
          cur.weight = 0;
        }
      }
      if (!visited.has(v.id)) {
        q.push(v.id);
        visited.set(v.id, null);
      }
    }
  }
};

const findNearestPoint = (lat, lon, graph) => {
  let minDistance = Number.MAX_VALUE;
  let minPoint;
  for (const point of graph.values()) {
    const distance = haversine(
      { latitude: lat, longitude: lon },
      {
        latitude: point.lat,
        longitude: point.long,
      }
    );
    if (distance < minDistance) {
      minDistance = distance;
      minPoint = point;
    }
  }
  return minPoint;
};

// dijkstra's algorithm to find shortest path
// start and end are both geohashed using findNearestPoint()
const buildPath = (start, end, graph) => {
  const path = [];
  const visited = new HashMap();
  const dist = new HashMap();
  const prev = new HashMap();
  const pq = new PriorityQueue((a, b) => b.dist - a.dist);
  dist.set(start, 0);
  for (const point of graph.keys()) {
    if (point !== start) {
      dist.set(point, Number.MAX_VALUE);
    }
  }
  pq.enq({ key: start, dist: 0 });
  while (!pq.isEmpty()) {
    const cur = pq.deq().key;
    visited.set(cur, null);
    for (const pair of graph.get(cur).adj) {
      const v = pair.id;
      const { weight } = pair;
      const alt = dist.get(cur) + weight;
      if (alt < dist.get(v)) {
        dist.set(v, alt);
        prev.set(v, cur);
        if (!visited.has(v)) {
          pq.enq({ key: v, dist: alt });
        }
      }
    }
  }
  if (!prev.has(end)) {
    return false;
  }
  let cur = end;
  while (cur !== start) {
    const point = graph.get(cur);
    path.push({ latitude: point.lat, longitude: point.long });
    cur = prev.get(cur);
  }
  const point = graph.get(cur);
  path.push({ latitude: point.lat, longtiude: point.long });
  return path;
};

// GET - get path coordinates for safest path
router.get("/safest", async (req, res) => {
  const { lat1, long1, lat2, long2 } = req.body;

  // get geoJSON for all paths
  const allPathsGeoJSON = await getAllPathsGeoJSON(
    getExpandedBounds(lat1, long1, lat2, long2)
  );
  // get geoJSON for bike paths
  const bikePathsGeoJSON = await getBikePathsGeoJSON(
    getExpandedBounds(lat1, long1, lat2, long2)
  );
  // build all paths and bike paths graphs
  const allPaths = buildGraph(allPathsGeoJSON);
  const bikePaths = buildGraph(bikePathsGeoJSON);
  // get the nearest points from the start and end coordinates
  const startPoint = findNearestPoint(lat1, long1, allPaths);
  const endPoint = findNearestPoint(lat2, long2, allPaths);
  // hash points
  const start = geohash.encode(startPoint.lat, startPoint.long, 9);
  const end = geohash.encode(endPoint.lat, endPoint.long, 9);
  // reduce weight of bike path edge on all paths graph
  reduceSafeWeights(start, allPaths, bikePaths);
  // build final path with all paths graph
  const path = buildPath(start, end, allPaths);
  if (!path) {
    res.sendStatus(500);
  }
  res.send(path);

  // find safest path based on graph

  // res.send(path)
  // const path = [
  //   {
  //     lat: 0.0,
  //     long: 0.0,
  //   },
  // ];
});

module.exports = router;
