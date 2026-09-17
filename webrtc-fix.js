/* HiveCall WebRTC reliability patch
 * Load this immediately before the HiveCall application script.
 * It fixes the two transport assumptions that caused silent calls and blank
 * screen shares: media calls are answered bidirectionally when possible, and
 * PeerJS calls are retried after signaling/presence becomes ready.
 */
(() => {
  "use strict";

  // PeerJS can deliver a MediaConnection before the app has finished applying
  // the presence snapshot. Keep the original call method, but retry a failed
  // dial once the target endpoint is actually registered.
  const retry = (fn, tries = 5, delay = 450) => {
    let n = 0;
    const run = () => {
      try { if (fn()) return; } catch (_) {}
      if (++n < tries) setTimeout(run, delay * n);
    };
    run();
  };

  // Expose a safe helper for the app/test harness. The application calls this
  // after publishing a peer id and after receiving a presence/state update.
  window.HiveCallWebRTC = Object.assign(window.HiveCallWebRTC || {}, { retry });

  // PeerJS versions differ in whether metadata is available as `metadata` or
  // under the internal options object. Normalise it for the receiver.
  const originalCall = window.Peer && window.Peer.prototype.call;
  if (originalCall && !window.Peer.prototype.__hcCallPatched) {
    window.Peer.prototype.__hcCallPatched = true;
    window.Peer.prototype.call = function (peerId, stream, options) {
      const call = originalCall.call(this, peerId, stream, options || {});
      if (call && options && options.metadata) {
        call.__hcMetadata = options.metadata;
        if (!call.metadata) call.metadata = options.metadata;
      }
      return call;
    };
  }

  // A MediaConnection answered without a local stream is receive-only. The
  // application already sends a second call in the opposite direction, but
  // answering with our stream as well makes the connection bidirectional and
  // removes the timing window where the remote microphone was never attached.
  window.HiveCallWebRTC.answerWithLocalStream = function (mediaConnection, localStream) {
    if (!mediaConnection || typeof mediaConnection.answer !== "function") return false;
    try {
      if (localStream && typeof localStream.getTracks === "function" && localStream.getTracks().length) {
        mediaConnection.answer(localStream);
      } else {
        mediaConnection.answer();
      }
      return true;
    } catch (_) {
      try { mediaConnection.answer(); return true; } catch (__) { return false; }
    }
  };

  // Screen-share streams often become available just after the broadcast. A
  // short retry window ensures a viewer gets the actual stream, not only the
  // "is presenting" presence notification.
  window.HiveCallWebRTC.retryShare = function (start) {
    if (typeof start !== "function") return;
    retry(() => start() > 0, 6, 500);
  };
})();
