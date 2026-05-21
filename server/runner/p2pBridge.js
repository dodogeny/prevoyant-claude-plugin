'use strict';

// Lightweight in-process state store for the P2P KB sync worker.
// index.js writes via updateState() as worker messages arrive.
// routes.js reads via getState() for the /p2p/peers API.

let state = {
  enabled:     false,
  installing:  false,   // true while npm install is running
  installLog:  '',      // last install status line
  selfId:      null,
  addrs:       [],
  peers:       [],      // [{ id, addrs, latencyMs, protocols }]
  topic:       'prevoyant/kb-sync/1',
  started:     null,
  lastSync:      null,  // { ts, machine, ticket, direction: 'in'|'out', filesCount }
  lastFilePaths: [],    // file paths from most recent sync event (in or out)
  transfer:      null,  // { phase, done, total, file } while a sync is in flight; null otherwise
  syncsIn:       0,
  syncsOut:      0,
  filesIn:       0,
  filesOut:      0,
  // Collective Intelligence Mesh
  cortexMeshEnabled: false,
  cortexObsIn:       0,   // observations received from network peers
  cortexObsOut:      0,   // observations broadcast to network
  cortexTotal:       0,   // current size of the worker's observation cache
  lastCortexSync:    null, // { ts, direction: 'in'|'out', count }
};

function updateState(patch) {
  Object.assign(state, patch);
}

function getState() {
  return { ...state, peers: [...state.peers] };
}

module.exports = { updateState, getState };
