class Rater {

  constructor(bucketCount=10, bucketSpanMs=1000) {
    this.bucketCount = bucketCount;
    this.bucketSpanMs = bucketSpanMs;
    this.buckets = {};
    this.start();
  }

  start() {
    this.iv = setInterval(_ => {
      for (const key in this.buckets) {
        if (key < Date.now() - (this.bucketCount * this.bucketSpanMs)) {
          delete this.buckets[key];
        }
      }
    }, this.bucketSpanMs);
  }

  stop() {
    clearTimeout(this.iv);
  }

  increment() {
    const key = this._key(Date.now());
    this.buckets[key] = (this.buckets[key] || 0) + 1;
  }

  _key(ts) {
    return (Math.floor(ts / this.bucketSpanMs)) * this.bucketSpanMs;
  }

  rate() {
    let sum = null;
    let span = 0;

    for (let i = -this.bucketCount + 1; i <= 0; i++) {
      const key = this._key(Date.now() + i * this.bucketSpanMs);
      if (!(key in this.buckets) && sum === null) continue;
      sum = (sum || 0) + (this.buckets[key] || 0);
      span += this.bucketSpanMs;
    }
    return (span ? sum / span : null) * 1000;
  }

}

module.exports = Rater;
