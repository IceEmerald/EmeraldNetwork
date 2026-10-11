/* Microphone capture for a live voice call.

   Runs on the audio thread and does nothing but collect raw mono frames
   and hand them to the main thread in fixed-size blocks. Resampling to
   the transport rate and the level metering both happen on the main
   thread, which keeps this free of any allocation per render quantum. */

class LivePcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = (options && options.processorOptions && options.processorOptions.blockSize) || 4096;
    this._block = new Float32Array(size);
    this._filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    /* No input wired up (track ended, permission revoked) — stay alive
       so the node keeps the graph running rather than tearing it down. */
    if (!channels || !channels.length) return true;

    const frame = channels[0];
    if (!frame) return true;

    for (let i = 0; i < frame.length; i++) {
      this._block[this._filled++] = frame[i];
      if (this._filled === this._block.length) {
        /* Transfer a copy; the block is reused on the next quantum. */
        this.port.postMessage(this._block.slice(0));
        this._filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('live-pcm-capture', LivePcmCapture);