// @ts-check
/* eslint-env browser, es2020 */
'use strict';

/**
 * Progress Circle Meters
 *
 * To initialize, first set the total: circleThingy.total = total;
 * Call start when ready: circleThingy.start();
 * May alternativly initialize & start: circleThingy.start(total);
 * Send updated value: circleThingy.current = currentValue;
 * Increment value: circleThingy.current++;
 */
export class ProgressCircleThingy extends HTMLElement {
  static PROGRESS_COLOR() { return '#6760F1'; }
  static TIME_COLOR() { return '#F5A262'; }
  static GOOD_COLOR() { return '#E2690C'; }
  static LATE_COLOR() { return '#E2980C'; }
  static BAD_COLOR() { return '#E53A43'; }
  static GREY_COLOR() { return '#BBBBBB'; }
  static defaultColor() { return ProgressCircleThingy.PROGRESS_COLOR(); }
  constructor() {
    super();
    this.total = 0;
    this.startAngle = 3 / 4 * Math.PI;
    this.endAngle = 1 / 4 * Math.PI;
    this.pathAngle = 2 * Math.PI - (this.startAngle - this.endAngle);
    this.style.position = 'relative';
    this.style.lineHeight = '1';
    this.dpr = window.devicePixelRatio || 1;
    this.shadow = this.attachShadow({ mode: 'open' });
    const makeCanvas = (width = 200) => {
      const canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.width = width * this.dpr;
      canvas.height = width * this.dpr;
      canvas.style.width = width + 'px';
      canvas.style.height = width + 'px';
      canvas.style.maxWidth = 'calc((100vw - 20px) / 3)';
      canvas.style.maxHeight = 'calc((100vw - 20px) / 3)';
      return canvas;
    };
    this.canvas = makeCanvas();
    this.shadow.appendChild(this.canvas);
    this.context = this.canvas.getContext('2d');
    this.context.scale(this.dpr, this.dpr);
    this.context.lineWidth = 15;
    this.context.strokeStyle = ProgressCircleThingy.GREY_COLOR();
    this.context.arc(
      this.canvas.width / 2 / this.dpr,
      this.canvas.width / 2 / this.dpr,
      this.canvas.width / 2 / this.dpr - 15,
      this.startAngle,
      this.endAngle
    );
    this.context.stroke();
    this.canvas = makeCanvas();
    this.shadow.appendChild(this.canvas);
    this.context = this.canvas.getContext('2d');
    this.context.scale(this.dpr, this.dpr);
    this.context.lineWidth = 15;
    this.context.strokeStyle = ProgressCircleThingy.GOOD_COLOR();
    this.bigText = document.createElement('div');
    const bigTextSizeQuery = window.matchMedia('(min-width: 450px)');
    const bigTextSizeTest = (e) => this.bigText.style.fontSize = e.matches ? '42px' : '9.75vw';
    bigTextSizeTest(bigTextSizeQuery);
    bigTextSizeQuery.addListener(bigTextSizeTest);
    this.bigText.style.margin = '38% auto 0';
    this.bigText.style.textAlign = 'center';
    this.shadow.appendChild(this.bigText);
    this.smallText = document.createElement('div');
    const smallTextSizeQuery = window.matchMedia('(max-width: 467px)');
    const smallTextSizeTest = (e) => {
      this.smallText.style.paddingLeft = e.matches ? '0' : '50%';
      this.smallText.style.textAlign = e.matches ? 'center' : 'left';
    };
    smallTextSizeTest(smallTextSizeQuery);
    smallTextSizeQuery.addListener(smallTextSizeTest);
    this.smallText.style.fontSize = '16px';
    this.smallText.style.margin = '5px auto';
    this.smallText.style.width = '50%';
    this.shadow.appendChild(this.smallText);
    this.percentText = document.createElement('div');
    this.percentText.style.fontFamily = "'Squada One', sans-serif";
    this.percentText.style.fontSize = '20px';
    this.percentText.style.margin = '14% auto 0';
    this.percentText.style.textAlign = 'right';
    this.percentText.style.width = '20%';
    this.percentText.style.display = 'none';
    this.shadow.appendChild(this.percentText);
  }
  get current() { return Number(this.getAttribute('current')); }
  set current(val) {
    this.setAttribute('current', val ? String(val) : '0');
    this.update();
  }
  get total() { return Number(this.getAttribute('total')); }
  set total(val) {
    this.setAttribute('total', val ? String(val) : '0');
  }
  get percent() { return Number(this.getAttribute('percent')); }
  set percent(val) {
    this.setAttribute('percent', val ? String(val > 1 ? 1 : val) : '0');
    this.percentText.innerHTML = (val * 100).toFixed(0) + '%';
  }
  start(total = 0) {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.strokeStyle = this.constructor.defaultColor(); // remove method call in field
    this.current = 0;
    this.painted = 0;
    this.total = total ? total : this.total;
  }
  update() {
    this.percent = this.current / this.total;
    this.bigText.innerHTML = String(this.current);
    this.smallText.innerHTML = '/ ' + this.total;
  }
}

export class SentCircleThingy extends ProgressCircleThingy {
  static defaultColor() { return ProgressCircleThingy.PROGRESS_COLOR(); }
  sent() {
    const draw = () => {
      this.current++;
      this.context.beginPath();
      this.context.arc(
        this.canvas.width / 2 / this.dpr,
        this.canvas.width / 2 / this.dpr,
        this.canvas.width / 2 / this.dpr - 15,
        this.startAngle + this.pathAngle * (this.painted / this.total),
        this.endAngle - this.pathAngle * (1 - this.current / this.total)
      );
      this.context.stroke();
      this.painted = this.current;
    };
    window.requestAnimationFrame(draw);
  }
  /** @param {number[]} failed Indexes of failed pings */
  setResults(failed) {
    // eslint-disable-next-line
    const drawGood = () => {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.context.strokeStyle = ProgressCircleThingy.GOOD_COLOR();
      this.context.beginPath();
      this.context.arc(
        this.canvas.width / 2 / this.dpr,
        this.canvas.width / 2 / this.dpr,
        this.canvas.width / 2 / this.dpr - 15,
        this.startAngle,
        this.endAngle - this.pathAngle * (1 - this.percent)
      );
      this.context.stroke();
    };
    const drawFailed = () => {
      failed.forEach(j => {
        this.context.strokeStyle = ProgressCircleThingy.BAD_COLOR();
        this.context.beginPath();
        this.context.arc(
          this.canvas.width / 2 / this.dpr,
          this.canvas.width / 2 / this.dpr,
          this.canvas.width / 2 / this.dpr - 15,
          this.startAngle + this.pathAngle * (j / this.total),
          this.endAngle - this.pathAngle * (1 - (j + 1) / this.total)
        );
        this.context.stroke();
      });
    };
    // window.requestAnimationFrame(drawGood);
    window.requestAnimationFrame(drawFailed);
  }
}

export class TimeCircleThingy extends ProgressCircleThingy {
  static defaultColor() { return ProgressCircleThingy.TIME_COLOR(); }
  start(total = 0) {
    this.total = total ? total : this.total;
    super.start();
    this.startTime = performance.now();
    this.endTime = this.startTime + this.total * 1000;
    this.nextTick = this.startTime + 1000;
    /** @param {DOMHighResTimeStamp} now */
    const draw = (now) => {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.context.beginPath();
      this.percent = 1 - (this.endTime - now) / (this.total * 1000);
      this.context.arc(
        this.canvas.width / 2 / this.dpr,
        this.canvas.width / 2 / this.dpr,
        this.canvas.width / 2 / this.dpr - 15,
        this.startAngle,
        this.endAngle - this.pathAngle * (1 - this.percent)
      );
      this.context.stroke();
      if (now >= this.nextTick) {
        this.current++;
        this.nextTick += 1000;
      }
      if (now <= this.endTime)
        window.requestAnimationFrame(draw);
    };
    window.requestAnimationFrame(draw);
  }
  update() {
    this.percent = this.current / this.total;
    this.bigText.innerHTML = this.format(this.current);
    this.smallText.innerHTML = '/ ' + this.format(this.total);
  }
  /** @param {number} n */
  format(n) {
    return Math.floor(n / 60) + ':' + (n % 60).toString().padStart(2, '0');
  }
}

export class ReceivedCircleThingy extends ProgressCircleThingy {
  received() {
    const draw = () => {
      this.current++;
      this.context.beginPath();
      this.context.arc(
        this.canvas.width / 2 / this.dpr,
        this.canvas.width / 2 / this.dpr,
        this.canvas.width / 2 / this.dpr - 15,
        this.startAngle + this.pathAngle * (this.painted / this.total),
        this.endAngle - this.pathAngle * (1 - this.current / this.total)
      );
      this.context.stroke();
      this.painted = this.current;
    };
    window.requestAnimationFrame(draw);
  }
  finish() {
    /** @type {ProgressCircleThingy} */
    const sentCircle = document.querySelector('sent-circle-thingy');
    if (this.painted + 1 < sentCircle.current) {
      const draw = () => {
        this.context.strokeStyle = ProgressCircleThingy.TIME_COLOR();
        this.context.beginPath();
        this.context.arc(
          this.canvas.width / 2 / this.dpr,
          this.canvas.width / 2 / this.dpr,
          this.canvas.width / 2 / this.dpr - 15,
          this.startAngle + this.pathAngle * (this.painted / this.total),
          this.endAngle - this.pathAngle * (1 - sentCircle.percent)
        );
        this.context.stroke();
        this.context.strokeStyle = ProgressCircleThingy.PROGRESS_COLOR();
      };
      window.requestAnimationFrame(draw);
    }
  }
}
