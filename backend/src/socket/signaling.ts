import type { Server, Socket } from "socket.io";
import { SessionManager, normalizeSessionId } from "./sessionManager.js";

interface CreatePayload {
  name?: string;
}

interface JoinPayload {
  sessionId?: string;
  name?: string;
}

interface OfferPayload {
  sessionId?: string;
  offer?: Record<string, unknown>;
}

interface AnswerPayload {
  sessionId?: string;
  answer?: Record<string, unknown>;
}

interface CandidatePayload {
  sessionId?: string;
  candidate?: Record<string, unknown>;
}

interface WatchPayload {
  sessionId?: string;
  action: "load" | "play" | "pause" | "seek" | "state" | "sync" | "playlist-add" | "playlist-remove" | "playlist-play";
  videoId?: string;
  currentTime?: number;
  isPlaying?: boolean;
  playlistIndex?: number;
}

const CREATE_LIMIT = 5;
const CREATE_WINDOW_MS = 60_000;
const createAttempts = new Map<string, number[]>();

function canCreateSession(socket: Socket): boolean {
  const key = socket.handshake.address;
  const now = Date.now();
  const attempts = (createAttempts.get(key) ?? []).filter((time) => now - time < CREATE_WINDOW_MS);
  if (attempts.length >= CREATE_LIMIT) {
    createAttempts.set(key, attempts);
    return false;
  }
  attempts.push(now);
  createAttempts.set(key, attempts);
  return true;
}

function isSessionDescription(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" && typeof (value as { sdp?: unknown }).sdp === "string");
}

function isIceCandidate(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && typeof (value as { candidate?: unknown }).candidate === "string");
}

export function setupSignaling(io: Server, sessions: SessionManager): void {
  io.on("connection", (socket: Socket) => {
    socket.on("create-session", (payload: CreatePayload) => {
      const existing = sessions.sessionOfSocket(socket.id);
      if (existing) {
        socket.emit("session-created", { sessionId: existing.id });
        return;
      }
      if (!canCreateSession(socket)) {
        socket.emit("session-error", {
          reason: "invalid",
          message: "Too many connection IDs created. Please wait a minute and try again.",
        });
        return;
      }
      const name = payload?.name?.trim() ?? "";
      const session = sessions.create();
      console.log(`[Signaling] Session created: ${session.id} (by ${socket.id}) name="${name}"`);
      const result = sessions.addPeer(session.id, socket.id, name || undefined);
      if (!result.ok) {
        socket.emit("session-error", {
          sessionId: session.id,
          reason: result.reason,
          message: "Could not create session.",
        });
        return;
      }
      socket.join(session.id);
      socket.emit("session-created", { sessionId: session.id });
    });

    socket.on("join-session", (payload: JoinPayload) => {
      const rawId = payload?.sessionId ?? "";
      const sessionId = normalizeSessionId(rawId);
      const name = payload?.name?.trim() ?? "";
      if (!sessionId) {
        socket.emit("session-error", {
          sessionId: rawId,
          reason: "invalid",
          message: "Please enter a valid connection ID.",
        });
        return;
      }
      const previous = sessions.sessionOfSocket(socket.id);
      const target = sessions.get(sessionId);
      if (!target || (target.peers.length >= 2 && !target.peers.includes(socket.id))) {
        socket.emit("session-error", {
          sessionId,
          reason: target ? "full" : "invalid",
          message: target ? "This session is already full." : "Session not found. Check the ID and try again.",
        });
        return;
      }
      if (previous && previous.id !== sessionId) {
        sessions.removeSocket(socket.id);
        socket.leave(previous.id);
        socket.to(previous.id).emit("peer-left", { sessionId: previous.id, peerId: socket.id });
      }
      const result = sessions.addPeer(sessionId, socket.id, name || undefined);
      if (!result.ok) {
        if (result.reason === "full") {
          console.log(`[Signaling] Join rejected (full): ${sessionId} (${socket.id})`);
          socket.emit("session-error", {
            sessionId,
            reason: "full",
            message: "This session is already full.",
          });
        } else {
          console.log(`[Signaling] Join rejected (invalid): ${sessionId} (${socket.id})`);
          socket.emit("session-error", {
            sessionId,
            reason: "invalid",
            message: "Session not found. Check the ID and try again.",
          });
        }
        return;
      }
      socket.join(sessionId);
      const session = result.session;
      // First peer in the session is the initiator; second is the receiver.
      // This is authoritative — clients must not rely solely on router state,
      // which is lost on refresh / direct navigation.
      const initiator = session.peers[0] === socket.id;
      const otherPeerId = session.peers.find((id) => id !== socket.id);
      const otherPeerName = otherPeerId ? sessions.getPeerName(sessionId, otherPeerId) : undefined;
      console.log(
        `[Signaling] Peer joined: ${sessionId} (${socket.id}) count=${session.peers.length} initiator=${initiator}`,
      );
      socket.emit("session-joined", {
        sessionId,
        peerId: socket.id,
        peerCount: session.peers.length,
        initiator,
        name,
        peerName: otherPeerName,
      });
      // Send current watch state to the new peer
      const watchState = sessions.getWatchState(sessionId);
      if (watchState && watchState.videoId) {
        socket.emit("watch:sync", {
          sessionId,
          action: "state",
          videoId: watchState.videoId,
          currentTime: watchState.currentTime,
          isPlaying: watchState.isPlaying,
          playlist: watchState.playlist,
          playlistIndex: watchState.playlistIndex,
          from: "server",
          timestamp: Date.now(),
        });
      }
      socket.to(sessionId).emit("peer-joined", {
        sessionId,
        peerId: socket.id,
        peerCount: session.peers.length,
        name,
      });
    });

    socket.on("webrtc-offer", (payload: OfferPayload) => {
      if (!payload?.sessionId || !isSessionDescription(payload.offer)) return;
      const sessionId = normalizeSessionId(payload.sessionId);
      if (!sessions.isParticipant(sessionId, socket.id)) return;
      console.log(`[Signaling] Routing offer: ${sessionId} (from ${socket.id})`);
      socket.to(sessionId).emit("webrtc-offer", {
        sessionId,
        offer: payload.offer,
        from: socket.id,
      });
    });

    socket.on("webrtc-answer", (payload: AnswerPayload) => {
      if (!payload?.sessionId || !isSessionDescription(payload.answer)) return;
      const sessionId = normalizeSessionId(payload.sessionId);
      if (!sessions.isParticipant(sessionId, socket.id)) return;
      console.log(`[Signaling] Routing answer: ${sessionId} (from ${socket.id})`);
      socket.to(sessionId).emit("webrtc-answer", {
        sessionId,
        answer: payload.answer,
        from: socket.id,
      });
    });

    socket.on("ice-candidate", (payload: CandidatePayload) => {
      if (!payload?.sessionId || !isIceCandidate(payload.candidate)) return;
      const sessionId = normalizeSessionId(payload.sessionId);
      if (!sessions.isParticipant(sessionId, socket.id)) return;
      console.log(`[Signaling] Routing ICE candidate: ${sessionId} (from ${socket.id})`);
      socket.to(sessionId).emit("ice-candidate", {
        sessionId,
        candidate: payload.candidate,
        from: socket.id,
      });
    });

    socket.on("leave-session", (payload: { sessionId?: string }) => {
      const session = sessions.sessionOfSocket(socket.id);
      if (session) {
        console.log(`[Signaling] Peer left: ${session.id} (${socket.id})`);
        socket.leave(session.id);
        socket.to(session.id).emit("peer-left", {
          sessionId: session.id,
          peerId: socket.id,
        });
      }
      sessions.removeSocket(socket.id);
    });

    // Watch Together events
    socket.on("watch:sync", (payload: WatchPayload) => {
      const rawId = payload?.sessionId ?? "";
      const sessionId = rawId ? normalizeSessionId(rawId) : undefined;
      if (!sessionId) return;

      if (!sessions.isParticipant(sessionId, socket.id)) return;

      if (payload.action === "playlist-add" && payload.videoId) {
        sessions.addToPlaylist(sessionId, { videoId: payload.videoId }, socket.id);
      } else if (payload.action === "playlist-remove" && Number.isInteger(payload.playlistIndex)) {
        sessions.removeFromPlaylist(sessionId, payload.playlistIndex!);
      } else if (payload.action === "playlist-play" && Number.isInteger(payload.playlistIndex)) {
        sessions.playPlaylistItem(sessionId, payload.playlistIndex!, socket.id);
      } else {
        const current = sessions.getWatchState(sessionId);
        if (current) {
          sessions.setWatchState(sessionId, {
            videoId: payload.videoId ?? current.videoId,
            currentTime: typeof payload.currentTime === "number" && payload.currentTime >= 0
              ? payload.currentTime
              : current.currentTime,
            isPlaying: payload.action === "load"
              ? false
              : typeof payload.isPlaying === "boolean"
                ? payload.isPlaying
                : current.isPlaying,
          }, socket.id);
        }
      }

      // Only route to the other peer
      socket.to(sessionId).emit("watch:sync", {
        ...payload,
        from: socket.id,
      });
    });

    socket.on("disconnect", () => {
      const session = sessions.sessionOfSocket(socket.id);
      sessions.removeSocket(socket.id);
      if (session) {
        console.log(`[Signaling] Peer disconnected: ${session.id} (${socket.id})`);
        socket.to(session.id).emit("peer-left", {
          sessionId: session.id,
          peerId: socket.id,
        });
      }
    });
  });
}
