// @ts-check
/* eslint-env browser, es2020 */
/* global Chart */
'use strict';

const BAD_COLOR = '#E53A43';
const GOOD_COLOR = '#E2690C';
const LATE_COLOR = '#E2980C';
const MEDIAN_COLOR = '#6760F1';

/** @param {number[]} arr Array of numbers */
const Median = (arr) => {
  const arrSorted = [...arr].sort((a, b) => a - b);
  return (arrSorted[arr.length - 1 >> 1] + arrSorted[arr.length >> 1]) / 2;
};

/** @type {import('chart.js').Chart} */
let chart;

if (!Chart) throw new Error('The Chart.js library failed to load.');
// Chart.defaults.global.elements.point.hitRadius = 2;
Chart.Tooltip.positioners.custom = (_, position) => position;

/**
 * Plot RTT latency and upstream jitter
 *
 * @param {string} id Chart div ID
 * @param {number[]} pingTimes RTT latency of received pings
 * @param {number} maxAcceptableLatency Maxiumum acceptable latency
 * @param {number[]} jitterTimes Upstream Inter-Packet Delay Variation (raw)
 * @param {number[]} jitterTimesRfc3550 Upstream Inter-Packet Delay Variation (RFC 3550)
 * @param {number[]} upFailed Upload pings that were lost
 * @param {number[]} downFailed Download pings that were lost
 */
export const drawChart = (id, pingTimes, maxAcceptableLatency, jitterTimes, jitterTimesRfc3550, upFailed, downFailed) => {
  const failed = upFailed.concat(downFailed).sort((a, b) => a - b);
  jitterTimes.unshift(0);
  jitterTimesRfc3550.unshift(0);
  for (let i = 1; i < pingTimes.length; i++) {
    if (failed.length > 0 && i - 1 === failed.shift()) {
      pingTimes.splice(i, 0, 0);
      jitterTimes.splice(i, 0, 0);
      jitterTimes.splice(i, 0, 0);
    }
  }
  jitterTimes = jitterTimes.map(x => parseFloat(x.toFixed(2)));
  jitterTimesRfc3550 = jitterTimesRfc3550.map(x => parseFloat(x.toFixed(2)));
  const colors = pingTimes.map(x => !x ? BAD_COLOR : x < maxAcceptableLatency ? GOOD_COLOR : LATE_COLOR);
  const labels = [...Array(pingTimes.length)].map((_, i) => 'Packet #' + i);
  const averageJitter = jitterTimes.reduce((a, b) => a + b) / jitterTimes.length;
  const medianPing = Median(pingTimes);
  const maxY = Math.ceil(Math.max(maxAcceptableLatency,
                                  medianPing + averageJitter * 2,
                                  Math.min(Math.max(...pingTimes), maxAcceptableLatency * 2)) / 5) * 5;
  /** @type {Chart.ChartConfiguration} */
  const chartOptions = {
    type: 'bar',
    data: {
      datasets: [{
        data: new Array(pingTimes.length).fill(parseFloat(medianPing.toFixed(2))),
        label: 'Median Latency',
        type: 'line',
        backgroundColor: MEDIAN_COLOR + 'aa',
        borderColor: MEDIAN_COLOR,
        borderWidth: 1,
        fill: false,
        pointRadius: 0,
        hoverRadius: 1
      }, {
        data: new Array(pingTimes.length).fill(parseFloat(maxAcceptableLatency.toFixed(2))),
        label: 'Maximum Acceptable Latency',
        type: 'line',
        backgroundColor: BAD_COLOR + 'aa',
        borderColor: BAD_COLOR,
        borderWidth: 0.5,
        fill: false,
        pointRadius: 0,
        hoverRadius: 1
      }, {
        data: jitterTimesRfc3550,
        label: 'Jitter',
        type: 'line',
        backgroundColor: BAD_COLOR + 'aa',
        borderColor: BAD_COLOR,
        borderWidth: 1,
        fill: false,
        pointRadius: 0,
        hoverRadius: 1
      }, {
        data: jitterTimes.map(x => parseFloat(x.toFixed(2))),
        label: 'Upstream Jitter',
        barPercentage: 1.0,
        categoryPercentage: 1.0,
        backgroundColor: BAD_COLOR + 'aa',
        borderColor: BAD_COLOR
      }, {
        data: pingTimes.map(x => parseFloat(x.toFixed(2))),
        label: 'RTT Latency',
        barPercentage: 1.0,
        categoryPercentage: 1.0,
        backgroundColor: colors.map(x => x + 'aa'),
        borderColor: colors
      }],
      labels: labels
    },
    options: {
      legend: { display: false },
      maintainAspectRatio: false,
      responsive: true,
      scales: {
        xAxes: [{
          stacked: true,
          gridLines: { display: false },
          ticks: { display: false }
        }],
        yAxes: [{
          ticks: {
            beginAtZero: true,
            max: maxY,
            callback: (value, index, values) => value + ' ms'
          }
        }]
      },
      tooltips: {
        position: 'custom',
        callbacks: {
          label: (tooltipItem, data) => {
            let label = data.datasets[tooltipItem.datasetIndex].label || '';
            if (label) label += ': ';
            label += tooltipItem.yLabel + ' ms';
            return label;
          }
        }
      }
    }
  };
  const chartContainer = document.getElementById('chartContainer');
  if (chart) chart.destroy();
  while (chartContainer.firstChild) {
    chartContainer.removeChild(chartContainer.firstChild);
  }
  const canvas = document.createElement('canvas');
  canvas.id = id;
  chartContainer.appendChild(canvas);
  chart = new Chart(canvas.getContext('2d'), chartOptions);
};
