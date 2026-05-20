'use strict';

// Lightweight in-process state store for the P2P KB sync worker.
// index.js writes via updateState() as worker messages arrive.
// routes.js reads via getState() for the /p2p/peers API.

let state = {
  enabled:  false,
  selfId:   null,
  addrs:    [],
  peers:    [],        // [{ id, addrs, latencyMs, protocols }]
  topic:    'prevoyant/kb-sync/1',
  started:  null,
  lastSync: null,      // { ts, machine, ticket, direction: 'in'|'out' }
  syncsIn:  0,
  syncsOut: 0,
};

function updateState(patch) {
  Object.assign(state, patch);
}

function getState() {
  return { ...state, peers: [...state.peers] };
}

module.exports = { updateState, getState };
