

class LivePcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = (options && options.processorOptions && options.processorOptions.blockSize) || 4096;
    this._block = new Float32Array(size);
    this._filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];

    if (!channels || !channels.length) return true;

    const frame = channels[0];
    if (!frame) return true;

    for (let i = 0; i < frame.length; i++) {
      this._block[this._filled++] = frame[i];
      if (this._filled === this._block.length) {

        this.port.postMessage(this._block.slice(0));
        this._filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('live-pcm-capture', LivePcmCapture);