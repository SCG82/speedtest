// @ts-check
/* eslint-env browser, es2020 */
'use strict';

const SERVER = 'pdx';
const PORT = 9000;
const DURATION = 10;
const PACKET_SIZE = 1000;
const PINGS_PER_SECOND = 312;
const START_DELAY = 2;
/** @type {RTCDataChannelInit} */
const DC_CONFIG = { ordered: false, maxRetransmits: 0 };
const PC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const PC_OPTIONAL = { optional: [{ googCpuOveruseDetection: false }] };
const OFFER_OPTIONS = { voiceActivityDetection: false };
const WS_URL = `wss://${location.hostname}:${PORT}/ws`;

/** @type {RTCDataChannel} */
let dc;
/** @type {RTCPeerConnection} */
let pc;
/** @type {WebSocket & {pinger?: number}} */
let ws;

/** @type {RTCIceCandidate[]} */
let candidates = [];
let ignoreOffer = false;
let makingOffer = false;
let metersStarted = false;
let polite = false;
let remoteDescriptionSet = false;

/** @type {{ipdv: number, rfc: number, rtt: number, rttRfc: number}[]} */
let jitter = [];
/** An estimate of the statistical variance of the upstream packet interarrival time (RFC 3550) */
let interarrivalJitter = 0;
/** An estimate of the statistical variance of the RTT packet interarrival time (RFC 3550) */
let rttJitter = 0;
/** Total upstream jitter (inter-packet delay variation) */
let totalIPDV = 0;
/** Sum of the variation between consecutive RTT latency measurements */
let totalRttJitter = 0;
let totalOriginIPD = 0;
let totalRemoteIPD = 0;
let pingsSent = 0;
let packetMeasurements = 0;

/**
 * High Precision Interval Timer
 * @param interval Call |callback| every |interval| milliseconds
 * @param duration Stop after |duration| milliseconds
 * @param callback Worker onmessage handler
 * @returns {Worker}
 */
const HpTimer = (() => {
  /** @type {Worker} */
  let w = null;
  /**
   * @param {number} interval
   * @param {number} duration
   * @param {(this: Worker, ev: {data: {id?: number, end?: number}}) => any} callback
   */
  const _HpTimer = (interval, duration, callback) => {
    if (typeof Worker === 'undefined') {
      console.error('Error: Web Workers not supported');
      return;
    }
    if (w)
      w.terminate();
    w = new Worker('./assets/workers/timer.js');
    w.onmessage = callback;
    w.postMessage({ interval: interval, duration: duration });
    console.log('HP Timer started');
    return w;
  };
  return _HpTimer;
})();

/**
 * Main function. Invoked by clicking the 'Start' button.
 */
function runTest() {
  const duration = DURATION;
  const pingsPerSecond = PINGS_PER_SECOND;
  const totalPings = duration * pingsPerSecond;
  /** @type {HTMLSelectElement} */ // @ts-ignore
  const server = SERVER;
  const port = PORT;
  const wsUrl = server ? `wss://${server}.rtctest.com:${port}/ws` :  WS_URL;
  ws = new WebSocket(wsUrl);
  ws.pinger = null;
  ws.onopen = wsOpen;
  ws.onmessage = wsMessage;
  ws.onclose = (ev) => {
    clearInterval(ws.pinger);
    ws.pinger = null;
    console.log('WebSocket closed');
    if (pc) pc.close();
  };
  ws.onerror = (ev) => {
    if (pc) pc.close();
  };
}

/**
 * WebSocket open handler
 * @this {WebSocket & {pinger: number}}
 */
function wsOpen() {
  metersStarted = false;
  /** @type {{i: number, ping: number, time: number, remoteTime: number}[]} */
  let pings = [];
  ws.pinger = setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 5 * 1000);
  // @ts-ignore
  pc = new RTCPeerConnection(PC_CONFIG, PC_OPTIONAL);
  pc.onconnectionstatechange = () => console.log(`peer connection ${pc.connectionState}`);
  pc.oniceconnectionstatechange = () => console.log(`ice connection state: ${pc.iceConnectionState}`);
  pc.onsignalingstatechange = () => console.log(`signaling state: ${pc.signalingState}`);
  pc.onicecandidate = (ev) => {
    if (!ev || !ev.candidate || !ev.candidate.candidate) return;
    const msg = { candidate: ev.candidate };
    ws.send(JSON.stringify(msg));
    console.log(ev.candidate);
    console.log(`ice candidate: ${ev.candidate.candidate.slice(10)}`);
  };
  pc.onnegotiationneeded = async () => {
    makingOffer = true;
    /** @type {RTCSessionDescription} */ // @ts-ignore
    const offer = await pc.createOffer(OFFER_OPTIONS).catch(console.error);
    if (pc.signalingState !== 'stable') return;
    await pc.setLocalDescription(offer).catch(console.error);
    const msg = { description: pc.localDescription };
    ws.send(JSON.stringify(msg));
    console.log('local description set');
    makingOffer = false;
  };
  // dc = pc.createDataChannel('channel', DC_CONFIG);
  pc.ondatachannel = (ev) => {
    if (!ev || !ev.channel) return;
    dc = ev.channel;
    dc.onopen = (ev) => {
      console.log('data channel open');
      HpTimer(1000 / PINGS_PER_SECOND, (START_DELAY + DURATION) * 1000, wwMessage);
    };
    dc.onclose = () => console.log('data channel closed');
    dc.onmessage = (ev) => {
      if (!ev.data) return;
      const pingsToSkip = START_DELAY * PINGS_PER_SECOND;
      /** @type {{i: number, time: number, remoteTime: number, type?: string, receivedCount?: string, list?: number[]}} */
      const json = JSON.parse(ev.data);
      if (!json) return;
      if (json.type === 'results') return onResults(json, pings);
      if (json.i < pingsToSkip) return;
      json.i -= pingsToSkip;
      const now = performance.now();
      const ping = now - json.time;
      const item = { ...json, timeReceived: now, ping: ping };
      pings.push(item);
    };
  };
}

/**
 * WebSocket message handler
 * @param {MessageEvent} ev
 * @this {WebSocket}
 */
async function wsMessage(ev) {
  if (!ev || !ev.data) return console.log('Error: wsMessage event ');
  /** @type {{ description: RTCSessionDescription, candidate: RTCIceCandidate }} */
  const json = JSON.parse(ev.data);
  if (!json) return console.log('Error: json undefined (wsMessage)');
  if (json.description) {
    console.log(`${json.description.type} received`);
    console.log(json.description);
    const offerCollision = json.description.type === 'offer' &&
                           (makingOffer || pc.signalingState !== 'stable');
    ignoreOffer = !polite && offerCollision;
    if (ignoreOffer) return;
    if (offerCollision)
      await Promise.all([
        pc.setLocalDescription({ type: 'rollback' }),
        pc.setRemoteDescription(json.description)
      ]).catch(console.error);
    else
      await pc.setRemoteDescription(json.description).catch(console.error);
    remoteDescriptionSet = true;
    console.log('remote description set');
    await Promise.all(candidates.map(addIceCandidate)).catch(console.error);
    candidates.length = 0;
    if (json.description.type === 'offer') {
      /** @type {RTCSessionDescription} */ // @ts-ignore
      const answer = await pc.createAnswer(OFFER_OPTIONS).catch(console.error);
      await pc.setLocalDescription(answer).catch(console.error);
      console.log('local description set');
      const msg = { description: pc.localDescription };
      ws.send(JSON.stringify(msg));
    }
  }
  else if (json.candidate) {
    if (json.candidate.candidate) {
      if (remoteDescriptionSet)
        await addIceCandidate(json.candidate).catch(console.error);
      else
        candidates.push(json.candidate);
    }
  }
}

/**
 * HPTimer message handler. Receives messages from |postMessage| in web worker 'timer.js'.
 * @param {MessageEvent & {id?: number, end?: number}} ev
 * @this {Worker}
 */
function wwMessage(ev) {
  if (!ev.data) return;
  if (ev.data.end) {
    console.log('HP Timer complete');
    this.terminate();
  }
  const pingsToSkip = START_DELAY * PINGS_PER_SECOND;
  const totalPings = (START_DELAY + DURATION) * PINGS_PER_SECOND;
  if (ev.data.id !== -1 && ev.data.id >= totalPings) return;
  const msg = { i: ev.data.id, time: performance.now(), size: PACKET_SIZE };
  dc.send(JSON.stringify(msg).padEnd(PACKET_SIZE, ' '));
  if (ev.data.id < pingsToSkip) return;
  pingsSent++;
}

/**
 * Calculate latency and packet loss stats
 * @param {{i: number, time: number, remoteTime: number, type?: string, receivedCount?: string, list?: number[]}} json
 * @param {{i: number, ping: number, time: number, remoteTime: number}[]} pings
 */
function onResults(json, pings) {
  ws.send(JSON.stringify({ terminate: { time: performance.now() } }));
  const pingsReceivedCount = pings.length;
  if (pingsReceivedCount === 0) return;
  const pingSize = PACKET_SIZE;
  const pingsPerSecond = PINGS_PER_SECOND;
  const duration = DURATION;
  const fps = 30;
  const startDelay = START_DELAY;
  const pingsToSkip = startDelay * pingsPerSecond;
  const totalPingsSent = pingsSent + pingsToSkip;
  const expectedInterFrameDelay = 1000 / fps;
  const expectedInterPacketDelay = 1000 / pingsPerSecond;
  const unsorted = [...json.list];
  pings.sort((a, b) => a.i - b.i);
  const averagePing = pings.reduce((a, b) => {
    return { i: b.i, ping: a.ping + b.ping, time: b.time - a.time, remoteTime: b.time - a.time };
  }).ping / pingsReceivedCount;
  const medianPing = median(pings.map(x => x.ping));
  const maxAcceptableLatency = medianPing + expectedInterFrameDelay;
  /** @type {{i: number, ping: number, time: number, remoteTime: number}[]} */
  let latePings = [];
  /** @type {number[]} */
  let remotePingsReceived = [];
  /** @type {number[]} */
  let downFailed = [];
  let downFailedCount = 0;
  /** @type {number[]} */
  let upFailed = [];
  let upFailedCount = 0;
  json.list.sort((a, b) => a - b);
  for (let n = 0; n < json.list.length; n++) {
    if (json.list[n] >= pingsToSkip)
      remotePingsReceived.push(json.list[n] - pingsToSkip);
  }
  const remotePingsReceivedCount = remotePingsReceived.length;
  for (let i = 0; i < remotePingsReceivedCount; i++) {
    while (i + upFailedCount < remotePingsReceived[i]) {
      upFailed.push(i + upFailedCount++);
    }
  }
  for (let j = 0; j < pingsReceivedCount; j++) {
    while (j + downFailedCount < pings[j].i) {
      downFailed.push(j + downFailedCount++);
    }
    if (pings[j].ping > maxAcceptableLatency)
      latePings.push(pings[j]);
  }
  while (pingsReceivedCount + downFailedCount < pingsSent) {
    downFailed.push(pingsReceivedCount + downFailedCount++);
  }
  while (remotePingsReceivedCount + upFailedCount < pingsSent) {
    upFailed.push(remotePingsReceivedCount + upFailedCount++);
  }
  let downFailedCountAdj = downFailedCount - upFailedCount;
  if (downFailedCountAdj < 0)
    downFailedCountAdj = 0;
  document.querySelector('sent-circle-thingy').setResults(upFailed);
  setResults(document.getElementById('upload'), upFailedCount, pingsSent);
  setResults(document.getElementById('download'), downFailedCountAdj, remotePingsReceivedCount);
  setResults(document.getElementById('late'), latePings.length, pingsSent);
  calculateJitter(pings);
  const averageJitter = totalRttJitter / packetMeasurements;
  const averageIPDV = totalIPDV / packetMeasurements;
  const averageBitrate = remotePingsReceivedCount * pingSize * 8 / duration / 1000 / 1000;
  document.getElementById('bitrate').innerHTML = averageBitrate.toFixed(2);
  document.getElementById('latency').innerHTML = medianPing.toFixed(2);
  document.getElementById('jitter').innerHTML = averageIPDV.toFixed(2);
  document.getElementById('jitterRTT').innerHTML = averageJitter.toFixed(2);
  console.log(`remote received:   ${json.receivedCount} packets (total):`);
  console.log(unsorted);
  console.log(`remote received:   ${remotePingsReceivedCount} packets (reindexed & sorted):`);
  console.log(remotePingsReceived);
  console.log(`pings received:    ${pingsReceivedCount} packets`);
  console.log(pings);
  if (downFailedCount > 0) {
    console.log(`downstream failed:`);
    console.log(downFailed);
  }
  if (upFailedCount > 0) {
    console.log(`upstream failed:`);
    console.log(upFailed);
  }
  console.log('jitter measurements:');
  console.log(jitter);
  console.log(`raw pings sent:    ${totalPingsSent} packets (total)`);
  console.log(`remote received:   ${json.receivedCount} packets (total)`);
  console.log(`pings to skip:     ${pingsToSkip}`);
  console.log(`pings sent:        ${pingsSent}`);
  console.log(`remote received:   ${remotePingsReceivedCount}`);
  console.log(`pings received:    ${pingsReceivedCount}`);
  console.log(`measurements:      ${packetMeasurements}`);
  console.log(`late pings:        ${latePings.length}`);
  console.log(`up failed:         ${upFailedCount}`);
  console.log(`down failed:       ${downFailedCount}`);
  console.log(`packetloss - up:   ${upFailedCount}/${pingsSent}`);
  console.log(`packetloss - down: ${downFailedCountAdj}/${remotePingsReceivedCount}`);
  console.log(`average bitrate:   ${averageBitrate.toFixed(3)} Mbps`);
  console.log(`average ping:      ${averagePing.toFixed(3)}`);
  console.log(`median ping:       ${medianPing.toFixed(3)}`);
  console.log(`avg jitter - up:   ${averageIPDV.toFixed(3)}`);
  console.log(`avg RTT jitter:    ${averageJitter.toFixed(3)}`);
  console.log(`expected IPD:      ${expectedInterPacketDelay.toFixed(3)}`);
  console.log(`avg origin IPD:    ${(totalOriginIPD / packetMeasurements).toFixed(3)}`);
  console.log(`avg remote IPD:    ${(totalRemoteIPD / packetMeasurements).toFixed(3)}`);
}

/**
 * Update HTML when sliders are changed
 */
function updatePredictedUse() {
  const duration = 10;
  const pingsPerSecond = 312;
  const totalPings = duration * pingsPerSecond;
  const pingSize = 1000;
  const overhead = 115; // approximate packet overhead
  const totalData = totalPings * pingSize + overhead;
}

/**
 * Add remote ice candidate to PeerConnection
 * @param {RTCIceCandidate} candidate
 */
function addIceCandidate(candidate) {
  return pc.addIceCandidate(candidate)
  .then(() => console.log(`remote ice candidate: ${candidate.candidate.slice(10)}`))
  .catch(err => {
    console.error(`Error adding remote ice candidate: ${candidate.candidate.slice(10)}`);
    console.error(err);
  });
}

/**
 * Calculate Jitter (Inter-Packet Delay Variation)
 * @param {{i: number, ping: number, time: number, remoteTime: number}[]} pings
 */
function calculateJitter(pings) {
  jitter.length = 0;
  interarrivalJitter = 0;
  rttJitter = 0;
  totalIPDV = 0;
  totalRttJitter = 0;
  totalOriginIPD = 0;
  totalRemoteIPD = 0;
  packetMeasurements = 0;
  for (let k = 1; k < pings.length; k++) {
    if (pings[k] !== undefined && pings[k - 1] !== undefined) {
      const originInterPacketDelay = pings[k].time - pings[k - 1].time;
      const remoteInterPacketDelay = pings[k].remoteTime - pings[k - 1].remoteTime;
      const interPacketDelayVariation = Math.abs(remoteInterPacketDelay - originInterPacketDelay);
      const latencyVariation = Math.abs(pings[k].ping - pings[k - 1].ping);
      totalOriginIPD += originInterPacketDelay;
      totalRemoteIPD += remoteInterPacketDelay;
      totalIPDV += interPacketDelayVariation;
      totalRttJitter += latencyVariation;
      if (interarrivalJitter === 0)
        interarrivalJitter = interPacketDelayVariation;
      else
        interarrivalJitter += (interPacketDelayVariation - interarrivalJitter) / 16; // RFC 3550
        // interarrivalJitter =
        //   interPacketDelayVariation > interarrivalJitter
        //     ? interarrivalJitter * 0.3 + interPacketDelayVariation * 0.7
        //     : interarrivalJitter * 0.8 + interPacketDelayVariation * 0.2; // https://github.com/librespeed/speedtest
      if (rttJitter === 0)
        rttJitter = latencyVariation;
      else
        rttJitter += (latencyVariation - rttJitter) / 16; // RFC 3550
      jitter.push({
        ipdv: interPacketDelayVariation,
        rtt: latencyVariation,
        rfc: interarrivalJitter,
        rttRfc: rttJitter
      });
      packetMeasurements++;
    }
  }
}

/**
 * Update HTML with results
 * @param {HTMLElement} div
 * @param {number} bad
 * @param {number} total
 */
function setResults(div, bad, total) {
  if (total === 0)
    div.querySelector('.percent').innerHTML = '--';
  else
    div.querySelector('.percent').innerHTML = (bad / total * 100).toFixed(1);
  div.querySelector('.counts').innerHTML = `(${bad} / ${total})`;
}

/**
 * Calculate median of array of numbers
 * @param {number[]} arr Array of numbers
 */
function median(arr) {
  const arrSorted = [...arr].sort((a, b) => a - b);
  return (arrSorted[arr.length - 1 >> 1] + arrSorted[arr.length >> 1]) / 2;
}
