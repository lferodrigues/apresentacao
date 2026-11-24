// Espelhamento de tela / câmera + microfone em tempo real (WebRTC).
//
// O vídeo vai direto do apresentador para cada visitante (ponto a ponto),
// como numa chamada de vídeo. O Firebase só faz a "apresentação" entre os
// aparelhos (sinalização):
//
//   rtc/{pin}/{idVisitante}/join    visitante pediu para assistir
//                          /offer   proposta do apresentador { oid, sdp }
//                          /answer  resposta do visitante    { oid, sdp }
//                          /pice    candidatos de rede do apresentador
//                          /vice    candidatos de rede do visitante
//
// "oid" identifica cada negociação; candidatos de negociações antigas são
// ignorados (ex.: apresentador recarregou a página).

import {
  ref, set, update, remove, push, onValue, onChildAdded, onChildRemoved,
  onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { ICE_SERVERS, VIDEO } from "./rtc-config.js";

const rid = () => Math.random().toString(36).slice(2, 10);
const RTC_CONFIG = { iceServers: ICE_SERVERS, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" };

export const canShareScreen = () => !!navigator.mediaDevices?.getDisplayMedia;
export const canUseCamera = () => !!navigator.mediaDevices?.getUserMedia;

/* =====================================================================
   APRESENTADOR: transmite para todos os visitantes
   ===================================================================== */
export class ScreenBroadcaster {
  constructor(db, pin, { onViewers, onSource, onError } = {}) {
    this.db = db;
    this.pin = pin;
    this.cb = { onViewers, onSource, onError };
    this.peers = new Map();       // idVisitante → { pc, oid, video, audio, pending, unsubs }
    this.stream = new MediaStream();
    this.videoTrack = null;
    this.source = null;           // "screen" | "camera" | null
    this.facing = "user";
    this.mode = "detail";         // "detail" (texto nítido) | "motion" (vídeo fluido)
    this.micTrack = null;
    this.micOn = false;
    this.sysTrack = null;
    this.audioTrack = null;
    this.mixer = null;
    this.unsubs = [];
  }

  /** Começa a aceitar visitantes. */
  listen() {
    const base = ref(this.db, `rtc/${this.pin}`);
    this.unsubs.push(onChildAdded(base, (s) => {
      if (s.val()?.join) this.addPeer(s.key).catch((e) => console.error("peer", e));
    }));
    this.unsubs.push(onChildRemoved(base, (s) => this.closePeer(s.key)));
  }

  /* ---------------- Fontes de vídeo ---------------- */
  async shareScreen() {
    const v = VIDEO.screen;
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: v.maxFramerate, max: v.maxFramerate }, width: { max: v.width }, height: { max: v.height } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: "include",
    });
    this.setVideo(s.getVideoTracks()[0], "screen");
    const sys = s.getAudioTracks()[0] || null;
    this.setSystemAudio(sys);
  }

  async shareCamera(facing = this.facing) {
    const v = VIDEO.camera;
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: v.width }, height: { ideal: v.height }, frameRate: { ideal: v.maxFramerate } },
    });
    this.facing = facing;
    this.setVideo(s.getVideoTracks()[0], "camera");
    this.setSystemAudio(null);
  }

  flipCamera() {
    return this.shareCamera(this.facing === "user" ? "environment" : "user");
  }

  setMode(mode) {
    this.mode = mode;
    if (this.videoTrack && this.source === "screen") this.videoTrack.contentHint = mode;
    for (const p of this.peers.values()) this.tune(p.video.sender);
  }

  setVideo(track, source) {
    const old = this.videoTrack;
    this.videoTrack = track;
    this.source = track ? source : null;
    if (track) {
      track.contentHint = source === "screen" ? this.mode : "motion";
      track.addEventListener("ended", () => {
        if (this.videoTrack === track) this.setVideo(null, null);
      });
    }
    this.stream.getVideoTracks().forEach((t) => this.stream.removeTrack(t));
    if (track) this.stream.addTrack(track);
    for (const p of this.peers.values()) {
      p.video.sender.replaceTrack(track).catch(() => {});
      this.tune(p.video.sender);
    }
    if (old && old !== track) old.stop();
    this.cb.onSource?.(this.source);
  }

  /* ---------------- Áudio (microfone + som do sistema) ---------------- */
  async setMic(on) {
    if (on && !this.micTrack) {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micTrack = s.getAudioTracks()[0];
    }
    this.micOn = on;
    this.updateAudio();
  }

  setSystemAudio(track) {
    if (this.sysTrack && this.sysTrack !== track) this.sysTrack.stop();
    this.sysTrack = track;
    track?.addEventListener("ended", () => { if (this.sysTrack === track) { this.sysTrack = null; this.updateAudio(); } });
    this.updateAudio();
  }

  updateAudio() {
    const mic = this.micOn && this.micTrack?.readyState === "live" ? this.micTrack : null;
    const sys = this.sysTrack?.readyState === "live" ? this.sysTrack : null;
    let track = mic || sys || null;
    if (mic && sys) track = this.mix(mic, sys);   // os dois juntos: mistura
    if (track === this.audioTrack) return;
    this.audioTrack = track;
    this.stream.getAudioTracks().forEach((t) => this.stream.removeTrack(t));
    if (track) this.stream.addTrack(track);
    for (const p of this.peers.values()) p.audio.sender.replaceTrack(track).catch(() => {});
  }

  mix(mic, sys) {
    if (!this.mixer) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.mixer = { ctx, dest: ctx.createMediaStreamDestination(), nodes: [] };
    }
    const m = this.mixer;
    m.ctx.resume?.();
    m.nodes.forEach((n) => n.disconnect());
    m.nodes = [mic, sys].map((t) => {
      const src = m.ctx.createMediaStreamSource(new MediaStream([t]));
      src.connect(m.dest);
      return src;
    });
    return m.dest.stream.getAudioTracks()[0];
  }

  /* ---------------- Conexões com os visitantes ---------------- */
  tune(sender) {
    try {
      const cfg = VIDEO[this.source || "screen"];
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = cfg.maxBitrate;
      params.encodings[0].maxFramerate = cfg.maxFramerate;
      params.degradationPreference =
        this.source === "screen" && this.mode === "detail" ? "maintain-resolution" : "balanced";
      sender.setParameters(params).catch(() => {});
    } catch {}
  }

  async addPeer(vid) {
    this.closePeer(vid);
    const node = `rtc/${this.pin}/${vid}`;
    const oid = rid();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const video = pc.addTransceiver("video", { direction: "sendonly", streams: [this.stream] });
    const audio = pc.addTransceiver("audio", { direction: "sendonly", streams: [this.stream] });
    const peer = { pc, oid, video, audio, pending: [], unsubs: [] };
    this.peers.set(vid, peer);
    this.countViewers();

    await video.sender.replaceTrack(this.videoTrack);
    await audio.sender.replaceTrack(this.audioTrack);

    pc.onicecandidate = (e) => {
      if (e.candidate) push(ref(this.db, `${node}/pice`), { oid, c: JSON.stringify(e.candidate) }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      this.countViewers();
      if (pc.connectionState === "failed") this.closePeer(vid);
    };

    await remove(ref(this.db, `${node}/pice`));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.tune(video.sender);
    await update(ref(this.db, node), { offer: { oid, type: offer.type, sdp: offer.sdp } });

    peer.unsubs.push(onValue(ref(this.db, `${node}/answer`), async (s) => {
      const a = s.val();
      if (!a || a.oid !== oid || pc.currentRemoteDescription || pc.signalingState === "closed") return;
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: a.sdp });
        for (const c of peer.pending.splice(0)) pc.addIceCandidate(c).catch(() => {});
      } catch (e) { console.warn("answer", e); }
    }));
    peer.unsubs.push(onChildAdded(ref(this.db, `${node}/vice`), (s) => {
      const v = s.val();
      if (!v || v.oid !== oid) return;
      const cand = JSON.parse(v.c);
      if (pc.currentRemoteDescription) pc.addIceCandidate(cand).catch(() => {});
      else peer.pending.push(cand);
    }));
  }

  closePeer(vid) {
    const p = this.peers.get(vid);
    if (!p) return;
    p.unsubs.forEach((u) => u());
    try { p.pc.close(); } catch {}
    this.peers.delete(vid);
    this.countViewers();
  }

  countViewers() {
    let n = 0;
    for (const p of this.peers.values()) if (p.pc.connectionState === "connected") n++;
    this.cb.onViewers?.(n, this.peers.size);
  }

  stopSharing() {
    this.setVideo(null, null);
    this.setSystemAudio(null);
  }

  /** Encerra tudo (sai da tela ou fecha a apresentação). */
  destroy() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    for (const vid of [...this.peers.keys()]) this.closePeer(vid);
    this.videoTrack?.stop();
    this.sysTrack?.stop();
    this.micTrack?.stop();
    this.mixer?.ctx.close().catch(() => {});
    this.videoTrack = this.sysTrack = this.micTrack = this.audioTrack = null;
    this.mixer = null;
  }
}

/* =====================================================================
   VISITANTE: recebe a transmissão
   ===================================================================== */
export class ScreenReceiver {
  constructor(db, pin, video, { onState } = {}) {
    this.db = db;
    this.pin = pin;
    this.video = video;
    this.onState = onState;
    this.pc = null;
    this.oid = null;
    this.cands = [];
    this.unsubs = [];
    this.stream = new MediaStream();
  }

  start() {
    this.vid = push(ref(this.db, `rtc/${this.pin}`)).key;
    const node = `rtc/${this.pin}/${this.vid}`;
    this.node = node;
    const nodeRef = ref(this.db, node);
    onDisconnect(nodeRef).remove().catch(() => {});
    set(nodeRef, { join: serverTimestamp() }).catch((e) => console.error(e));

    this.unsubs.push(onValue(ref(this.db, `${node}/offer`), (s) => {
      const o = s.val();
      if (o && o.oid !== this.oid) this.accept(o).catch((e) => console.error("offer", e));
    }));
    this.unsubs.push(onChildAdded(ref(this.db, `${node}/pice`), (s) => {
      const v = s.val();
      if (!v) return;
      const cand = { oid: v.oid, c: JSON.parse(v.c) };
      if (this.pc && v.oid === this.oid && this.pc.currentRemoteDescription) this.pc.addIceCandidate(cand.c).catch(() => {});
      else this.cands.push(cand);
    }));
  }

  async accept(offer) {
    this.closePc();
    this.oid = offer.oid;
    const oid = offer.oid;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    this.stream = new MediaStream();
    this.video.srcObject = this.stream;

    pc.ontrack = (e) => {
      // menor atraso possível: sem "colchão" extra de buffer
      try { e.receiver.jitterBufferTarget = 0; } catch {}
      try { e.receiver.playoutDelayHint = 0; } catch {}
      this.stream.addTrack(e.track);
      this.video.srcObject = this.stream;
      this.video.play().catch(() => {});
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) push(ref(this.db, `${this.node}/vice`), { oid, c: JSON.stringify(e.candidate) }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      this.onState?.(pc.connectionState);
      if (pc.connectionState === "failed") this.restart();
    };

    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await set(ref(this.db, `${this.node}/answer`), { oid, type: answer.type, sdp: answer.sdp });
    for (const c of this.cands.splice(0)) if (c.oid === oid) pc.addIceCandidate(c.c).catch(() => {});
    this.onState?.("connecting");
  }

  /** Recomeça com um novo pedido (ex.: a conexão caiu). */
  restart() {
    this.stop(false);
    setTimeout(() => { if (!this.stopped) this.start(); }, 1500);
  }

  closePc() {
    if (this.pc) { try { this.pc.close(); } catch {} }
    this.pc = null;
  }

  stop(final = true) {
    if (final) this.stopped = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.closePc();
    this.oid = null;
    this.cands = [];
    if (this.node) {
      const r = ref(this.db, this.node);
      onDisconnect(r).cancel().catch(() => {});
      remove(r).catch(() => {});
    }
    if (final) this.video.srcObject = null;
  }
}
