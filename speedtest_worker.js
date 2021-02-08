/**
 * @file LibreSpeed - Worker
 * @author Federico Dossena
 * @license LGPL-3.0-only
 * @see https://github.com/librespeed/speedtest/
 */

// data reported to main thread
let testState = -1; // -1=not started, 0=starting, 1=download test, 2=ping+jitter test, 3=upload test, 4=finished, 5=abort
let dlStatus = 0; // download speed in megabit/s with 2 decimal digits
let ulStatus = 0; // upload speed in megabit/s with 2 decimal digits
let pingStatus = 0; // ping in milliseconds with 2 decimal digits
let jitterStatus = 0; // jitter in milliseconds with 2 decimal digits
let clientIp = ""; // client's IP address as reported by getIP.php
let dlProgress = 0; // progress of download test 0-1
let ulProgress = 0; // progress of upload test 0-1
let pingProgress = 0; // progress of ping+jitter test 0-1
let testId = null; // test ID (sent back by telemetry if used, null otherwise)

let log = ""; // telemetry log
/**
 * @param {string} s
 */
function tlog(s) {
	if (settings.telemetry_level >= 2) {
		log += Date.now() + ": " + s + "\n";
	}
}
/**
 * @param {string} s
 */
function tverb(s) {
	if (settings.telemetry_level >= 3) {
		log += Date.now() + ": " + s + "\n";
	}
}
/**
 * @param {string} s
 */
function twarn(s) {
	if (settings.telemetry_level >= 2) {
		log += Date.now() + " WARN: " + s + "\n";
	}
	console.warn(s);
}

/**
 * Test settings - can be overridden by sending specific values with the start command
 */
const settings = {
	mpot: false, // set to true when in MPOT mode
	test_order: "IP_D_U", // order in which tests will be performed as a string. D=Download, U=Upload, P=Ping+Jitter, I=IP, _=1 second delay
	time_ul_min: 8, // min duration of upload test in seconds
	time_ul_max: 15, // max duration of upload test in seconds
	time_dl_min: 8, // min duration of download test in seconds
	time_dl_max: 15, // max duration of download test in seconds
	time_auto: true, // if set to true, tests will take less time on faster connections
	time_ulGraceTime: 3, // time to wait in seconds before actually measuring ul speed (wait for buffers to fill)
	time_dlGraceTime: 1.5, // time to wait in seconds before actually measuring dl speed (wait for TCP window to increase)
	count_ping: 35, // number of pings to perform in ping test
	url_dl: "backend/garbage.php", // path to a large file or garbage.php, used for download test. must be relative to this js file
	url_ul: "backend/empty.php", // path to an empty file, used for upload test. must be relative to this js file
	url_ping: "backend/garbage.php", // path to an empty file, used for ping test. must be relative to this js file
	url_getIp: "backend/getIP.php", // path to getIP.php relative to this js file, or a similar thing that outputs the client's ip
	getIp_ispInfo: true, // if set to true, the server will include ISP info with the IP address
	getIp_ispInfo_distance: "km", // km or mi=estimate distance from server in km/mi; set to false to disable distance estimation. getIp_ispInfo must be enabled in order for this to work
	xhr_dlMultistream: 6, // number of download streams to use (can be different if enable_quirks is active)
	xhr_ulMultistream: 3, // number of upload streams to use (can be different if enable_quirks is active)
	xhr_multistreamDelay: 300, // how much concurrent requests should be delayed
	xhr_ignoreErrors: 1, // 0=fail on errors, 1=attempt to restart a stream if it fails, 2=ignore all errors
	xhr_dlUseBlob: false, // if set to true, it reduces ram usage but uses the hard drive (useful with large garbagePhp_chunkSize and/or high xhr_dlMultistream)
	xhr_ul_blob_megabytes: 20, // size in megabytes of the upload blobs sent in the upload test (forced to 4 on chrome mobile)
	garbagePhp_chunkSize: 100, // size of chunks sent by garbage.php (can be different if enable_quirks is active)
	enable_quirks: true, // enable quirks for specific browsers. currently it overrides settings to optimize for specific browsers, unless they are already being overridden with the start command
	ping_allowPerformanceApi: true, // if enabled, the ping test will attempt to calculate the ping more precisely using the Performance API. Currently works perfectly in Chrome, badly in Edge, and not at all in Firefox. If Performance API is not supported or the result is obviously wrong, a fallback is provided.
	overheadCompensationFactor: 1.06, // can be changed to compensatie for transport overhead. (see doc.md for some other values)
	useMebibits: false, // if set to true, speed will be reported in mebibits/s instead of megabits/s
	telemetry_level: 0, // 0=disabled, 1=basic (results only), 2=full (results and timing) 3=debug (results+log)
	url_telemetry: "results/telemetry.php", // path to the script that adds telemetry data to the database
	telemetry_extra: "" // extra data that can be passed to the telemetry through the settings
};

/** @type {XMLHttpRequest[]} */
let xhr = null; // array of currently active xhr requests
/** @type {number} */
let interval = null; // timer used in tests
let test_pointer = 0; // pointer to the next test to run inside settings.test_order

/**
 * listener for commands from main thread to this worker.
 * commands:
 * - status: returns the current status as a JSON string containing testState, dlStatus, ulStatus, pingStatus, clientIp, jitterStatus, dlProgress, ulProgress, pingProgress
 * - abort: aborts the current test
 * - start: starts the test. optionally, settings can be passed as JSON.
 * @example
 * start {"time_ul_max":"10", "time_dl_max":"10", "count_ping":"50"}
 */
self.addEventListener("message", (e) => {
	const params = e.data.split(" ");
	if (params[0] === "status") {
		// return status
		postMessage(
			JSON.stringify({
				testState: testState,
				dlStatus: dlStatus,
				ulStatus: ulStatus,
				pingStatus: pingStatus,
				clientIp: clientIp,
				jitterStatus: jitterStatus,
				dlProgress: dlProgress,
				ulProgress: ulProgress,
				pingProgress: pingProgress,
				testId: testId
			})
		);
	}
	if (params[0] === "start" && testState === -1) {
		// start new test
		testState = 0;
		try {
			// parse settings, if present
			let s = {};
			try {
				const ss = e.data.substring(5);
				if (ss) s = JSON.parse(ss);
			} catch (e) {
				twarn("Error parsing custom settings JSON. Please check your syntax");
			}
			// copy custom settings
			for (const key in s) {
				if (typeof settings[key] !== "undefined") settings[key] = s[key];
				else twarn("Unknown setting ignored: " + key);
			}
			const ua = navigator.userAgent;
			// quirks for specific browsers. apply only if not overridden. more may be added in future releases
			if (settings.enable_quirks || typeof s.enable_quirks !== "undefined" && s.enable_quirks) {
				if (/Firefox.(\d+\.\d+)/i.test(ua)) {
					if (typeof s.ping_allowPerformanceApi === "undefined") {
						// ff performance API sucks
						settings.ping_allowPerformanceApi = false;
					}
				}
				if (/Edge.(\d+\.\d+)/i.test(ua)) {
					if (typeof s.xhr_dlMultistream === "undefined") {
						// edge more precise with 3 download streams
						settings.xhr_dlMultistream = 3;
					}
				}
				if (/Chrome.(\d+)/i.test(ua) && !!self.fetch) {
					if (typeof s.xhr_dlMultistream === "undefined") {
						// chrome more precise with 5 streams
						settings.xhr_dlMultistream = 5;
					}
				}
			}
			if (/Edge.(\d+\.\d+)/i.test(ua)) {
				// Edge 15 introduced a bug that causes onprogress events to not get fired, we have to use the "small chunks" workaround that reduces accuracy
				settings.forceIE11Workaround = true;
			}
			if (/PlayStation 4.(\d+\.\d+)/i.test(ua)) {
				// PS4 browser has the same bug as IE11/Edge
				settings.forceIE11Workaround = true;
			}
			if (/Chrome.(\d+)/i.test(ua) && /Android|iPhone|iPad|iPod|Windows Phone/i.test(ua)) {
				// cheap af
				// Chrome mobile introduced a limitation somewhere around version 65, we have to limit XHR upload size to 4 megabytes
				settings.xhr_ul_blob_megabytes = 4;
			}
			if (/^((?!chrome|android|crios|fxios).)*safari/i.test(ua)) {
				// Safari also needs the IE11 workaround but only for the MPOT version
				settings.forceIE11Workaround = true;
			}
			if (typeof s.telemetry_level !== "undefined") {
				// telemetry_level has to be parsed and not just copied
				settings.telemetry_level = s.telemetry_level === "basic" ? 1 : s.telemetry_level === "full" ? 2 : s.telemetry_level === "debug" ? 3 : 0;
			}
			// transform test_order to uppercase, just in case
			settings.test_order = settings.test_order.toUpperCase();
		} catch (e) {
			twarn("Possible error in custom test settings. Some settings might not have been applied. Exception: " + e);
		}
		// run the tests
		tverb(JSON.stringify(settings));
		test_pointer = 0;
		let iRun = false;
		let dRun = false;
		let uRun = false;
		let pRun = false;
		const runNextTest = () => {
			if (testState === 5) return;
			if (test_pointer >= settings.test_order.length) {
				// test is finished
				if (settings.telemetry_level > 0) {
					sendTelemetry((id) => {
						testState = 4;
						if (id != null) testId = id;
					});
				} else {
					testState = 4;
				}
				return;
			}
			switch (settings.test_order.charAt(test_pointer)) {
				case "I":
					test_pointer++;
					if (iRun) return void runNextTest();
					iRun = true;
					getIp(runNextTest);
					break;
				case "D":
					test_pointer++;
					if (dRun) return void runNextTest();
					dRun = true;
					testState = 1;
					dlTest(runNextTest);
					break;
				case "U":
					test_pointer++;
					if (uRun) return void runNextTest();
					uRun = true;
					testState = 3;
					ulTest(runNextTest);
					break;
				case "P":
					test_pointer++;
					if (pRun) return void runNextTest();
					pRun = true;
					testState = 2;
					pingTest(runNextTest);
					break;
				case "_":
					test_pointer++;
					setTimeout(runNextTest, 1000);
					break;
				default:
					test_pointer++;
			}
		};
		runNextTest();
	}
	if (params[0] === "abort") {
		// abort command
		if (testState >= 4) return; // test finished
		tlog("manually aborted");
		clearRequests(); // stop all xhr activity
		if (interval) clearInterval(interval); // clear timer if present
		if (settings.telemetry_level > 1) sendTelemetry(() => {});
		testState = 5; // set test as aborted
		dlStatus = 0;
		ulStatus = 0;
		pingStatus = 0;
		jitterStatus = 0;
		clientIp = "";
		dlProgress = 0;
		ulProgress = 0;
		pingProgress = 0;
	}
});

/**
 * stops all XHR activity, aggressively
 */
function clearRequests() {
	tverb("stopping pending XHRs");
	if (xhr) {
		for (let i = 0; i < xhr.length; i++) {
			try {
				xhr[i].onprogress = null;
				xhr[i].onload = null;
				xhr[i].onerror = null;
			} catch (e) {}
			try {
				xhr[i].upload.onprogress = null;
				xhr[i].upload.onload = null;
				xhr[i].upload.onerror = null;
			} catch (e) {}
			try { xhr[i].abort(); } catch (e) {}
			try { delete xhr[i]; } catch (e) {}
		}
		xhr = null;
	}
}

let ipCalled = false; // used to prevent multiple accidental calls to getIp
let ispInfo = ""; // used for telemetry
/**
 * gets client's IP using `url_getIp`, then calls the `done()` function
 * @param {() => void} done
 */
function getIp(done) {
	tverb("getIp");
	if (ipCalled) return;
	ipCalled = true; // getIp already called?
	const startT = new Date().getTime();
	const xhr = new XMLHttpRequest();
	xhr.onload = () => {
		tlog("IP: " + xhr.responseText + ", took " + (new Date().getTime() - startT) + "ms");
		try {
			const data = JSON.parse(xhr.responseText);
			clientIp = data.processedString;
			ispInfo = data.rawIspInfo;
		} catch (e) {
			clientIp = xhr.responseText;
			ispInfo = "";
		}
		done();
	};
	xhr.onerror = () => {
		tlog("getIp failed, took " + (new Date().getTime() - startT) + "ms");
		done();
	};
	xhr.open("GET", settings.url_getIp + url_sep(settings.url_getIp) + (settings.mpot ? "cors=true&" : "") + (settings.getIp_ispInfo ? "isp=true" + (settings.getIp_ispInfo_distance ? "&distance=" + settings.getIp_ispInfo_distance + "&" : "&") : "&") + "r=" + Math.random(), true);
	xhr.send();
}

let dlCalled = false; // used to prevent multiple accidental calls to dlTest
/**
 * download test, calls done function when it's over
 * @param {() => void} done
 */
function dlTest(done) {
	tverb("dlTest");
	if (dlCalled) return;
	dlCalled = true; // dlTest already called?
	let totLoaded = 0.0; // total number of loaded bytes
	let startT = new Date().getTime(); // timestamp when test was started
	let bonusT = 0; // how many milliseconds the test has been shortened by (higher on faster connections)
	let graceTimeDone = false; // set to true after the grace time is past
	let failed = false; // set to true if a stream fails
	xhr = [];
	/**
	 * function to create a download stream. streams are slightly delayed so that they will not end at the same time
	 * @param {number} i
	 * @param {number} delay
	 */
	const testStream = (i, delay) => {
		setTimeout(
			() => {
				if (testState !== 1) return; // delayed stream ended up starting after the end of the download test
				tverb("dl test stream started " + i + " " + delay);
				let prevLoaded = 0; // number of bytes loaded last time onprogress was called
				const x = new XMLHttpRequest();
				xhr[i] = x;
				xhr[i].onprogress = (event) => {
					tverb("dl stream progress event " + i + " " + event.loaded);
					// just in case this XHR is still running after the download test
					if (testState !== 1) try { x.abort(); } catch (e) {}
					// progress event, add number of new loaded bytes to totLoaded
					const loadDiff = event.loaded <= 0 ? 0 : event.loaded - prevLoaded;
					if (isNaN(loadDiff) || !isFinite(loadDiff) || loadDiff < 0) return; // just in case
					totLoaded += loadDiff;
					prevLoaded = event.loaded;
				};
				xhr[i].onload = () => {
					// the large file has been loaded entirely, start again
					tverb("dl stream finished " + i);
					try { xhr[i].abort(); } catch (e) {} // reset the stream data to empty ram
					testStream(i, 0);
				};
				xhr[i].onerror = () => {
					// error
					tverb("dl stream failed " + i);
					if (settings.xhr_ignoreErrors === 0) failed = true; // abort
					try { xhr[i].abort(); } catch (e) {}
					delete xhr[i];
					if (settings.xhr_ignoreErrors === 1) testStream(i, 0); // restart stream
				};
				// send xhr
				try {
					if (settings.xhr_dlUseBlob) xhr[i].responseType = "blob";
					else xhr[i].responseType = "arraybuffer";
				} catch (e) {}
				xhr[i].open("GET", settings.url_dl + url_sep(settings.url_dl) + (settings.mpot ? "cors=true&" : "") + "r=" + Math.random() + "&ckSize=" + settings.garbagePhp_chunkSize, true); // random string to prevent caching
				xhr[i].send();
			},
			1 + delay
		);
	};
	// open streams
	for (let i = 0; i < settings.xhr_dlMultistream; i++) {
		testStream(i, settings.xhr_multistreamDelay * i);
	}
	// every 200ms, update dlStatus
	interval = setInterval(
		() => {
			tverb("DL: " + dlStatus + (graceTimeDone ? "" : " (in grace time)"));
			const t = new Date().getTime() - startT;
			if (graceTimeDone) dlProgress = (t + bonusT) / (settings.time_dl_max * 1000);
			if (t < 200) return;
			if (!graceTimeDone) {
				if (t > 1000 * settings.time_dlGraceTime) {
					if (totLoaded > 0) {
						// if the connection is so slow that we didn't get a single chunk yet, do not reset
						startT = new Date().getTime();
						bonusT = 0;
						totLoaded = 0.0;
					}
					graceTimeDone = true;
				}
			} else {
				const speed = totLoaded / (t / 1000.0);
				if (settings.time_auto) {
					// decide how much to shorten the test. Every 200ms, the test is shortened by the bonusT calculated here
					const bonus = 5.0 * speed / 100000;
					//bonusT += bonus > 400 ? 400 : bonus;
					bonusT = Math.min(bonusT + Math.min(bonus, 400), settings.time_dl_max - settings.time_dl_min);
				}
				// update status
				dlStatus = Number((speed * 8 * settings.overheadCompensationFactor / (settings.useMebibits ? 1048576 : 1000000)).toFixed(2)); // speed is multiplied by 8 to go from bytes to bits, overhead compensation is applied, then everything is divided by 1048576 or 1000000 to go to megabits/mebibits
				if ((t + bonusT) / 1000.0 > settings.time_dl_max || failed) {
					// test is over, stop streams and timer
					if (failed || isNaN(dlStatus)) dlStatus = -1;
					clearRequests();
					clearInterval(interval);
					dlProgress = 1;
					tlog(`dlTest: ${dlStatus < 0 ? "Fail" : dlStatus}, took ${new Date().getTime() - startT}ms`);
					done();
				}
			}
		},
		200
	);
}

let ulCalled = false; // used to prevent multiple accidental calls to ulTest
/**
 * upload test, calls done function when it's over
 * @param {() => void} done
 */
function ulTest(done) {
	tverb("ulTest");
	if (ulCalled) return;
	ulCalled = true; // ulTest already called?
	// garbage data for upload test
	let r = new ArrayBuffer(1048576);
	const maxInt = Math.pow(2, 32) - 1;
	try {
		r = new Uint32Array(r);
		for (let i = 0; i < r.length; i++) {
			r[i] = Math.random() * maxInt;
		}
	} catch (e) {}
	const req = [];
	const reqsmall = [];
	for (let i = 0; i < settings.xhr_ul_blob_megabytes; i++) {
		req.push(r);
	}
	const request = new Blob(req);
	r = new ArrayBuffer(262144);
	try {
		r = new Uint32Array(r);
		for (let i = 0; i < r.length; i++) {
			r[i] = Math.random() * maxInt;
		}
	} catch (e) {}
	reqsmall.push(r);
	const requestS = new Blob(reqsmall);
	const testFunction = () => {
		let totLoaded = 0.0; // total number of transmitted bytes
		let startT = new Date().getTime(); // timestamp when test was started
		let bonusT = 0; // how many milliseconds the test has been shortened by (higher on faster connections)
		let graceTimeDone = false; // set to true after the grace time is past
		let failed = false; // set to true if a stream fails
		xhr = [];
		/**
		 * function to create an upload stream. streams are slightly delayed so that they will not end at the same time
		 * @param {number} i
		 * @param {number} delay
		 */
		const testStream = (i, delay) => {
			setTimeout(
				() => {
					if (testState !== 3) return; // delayed stream ended up starting after the end of the upload test
					tverb("ul test stream started " + i + " " + delay);
					let prevLoaded = 0; // number of bytes transmitted last time onprogress was called
					const x = new XMLHttpRequest();
					xhr[i] = x;
					let ie11workaround;
					if (settings.forceIE11Workaround) {
						ie11workaround = true;
					} else {
						try {
							xhr[i].upload.onprogress;
							ie11workaround = false;
						} catch (e) {
							ie11workaround = true;
						}
					}
					if (ie11workaround) {
						// IE11 workarond: xhr.upload does not work properly, therefore we send a bunch of small 256k requests and use the onload event as progress. This is not precise, especially on fast connections
						xhr[i].onload = xhr[i].onerror = () => {
							tverb("ul stream progress event (ie11wa)");
							totLoaded += requestS.size;
							testStream(i, 0);
						};
						xhr[i].open("POST", settings.url_ul + url_sep(settings.url_ul) + (settings.mpot ? "cors=true&" : "") + "r=" + Math.random(), true); // random string to prevent caching
						try {
							xhr[i].setRequestHeader("Content-Encoding", "identity"); // disable compression (some browsers may refuse it, but data is incompressible anyway)
						} catch (e) {}
						// No Content-Type header in MPOT branch because it triggers bugs in some browsers
						xhr[i].send(requestS);
					} else {
						// REGULAR version, no workaround
						xhr[i].upload.onprogress = (event) => {
							tverb("ul stream progress event " + i + " " + event.loaded);
							// just in case this XHR is still running after the upload test
							if (testState !== 3) try { x.abort(); } catch (e) {}
							// progress event, add number of new loaded bytes to totLoaded
							const loadDiff = event.loaded <= 0 ? 0 : event.loaded - prevLoaded;
							if (isNaN(loadDiff) || !isFinite(loadDiff) || loadDiff < 0) return; // just in case
							totLoaded += loadDiff;
							prevLoaded = event.loaded;
						};
						xhr[i].upload.onload = () => {
							// this stream sent all the garbage data, start again
							tverb("ul stream finished " + i);
							testStream(i, 0);
						};
						xhr[i].upload.onerror = () => {
							tverb("ul stream failed " + i);
							if (settings.xhr_ignoreErrors === 0) failed = true; // abort
							try { xhr[i].abort(); } catch (e) {}
							delete xhr[i];
							if (settings.xhr_ignoreErrors === 1) testStream(i, 0); // restart stream
						};
						// send xhr
						xhr[i].open("POST", settings.url_ul + url_sep(settings.url_ul) + (settings.mpot ? "cors=true&" : "") + "r=" + Math.random(), true); // random string to prevent caching
						try {
							xhr[i].setRequestHeader("Content-Encoding", "identity"); // disable compression (some browsers may refuse it, but data is incompressible anyway)
						} catch (e) {}
						// No Content-Type header in MPOT branch because it triggers bugs in some browsers
						xhr[i].send(request);
					}
				},
				delay
			);
		};
		// open streams
		for (let i = 0; i < settings.xhr_ulMultistream; i++) {
			testStream(i, settings.xhr_multistreamDelay * i);
		}
		// every 200ms, update ulStatus
		interval = setInterval(
			() => {
				tverb("UL: " + ulStatus + (graceTimeDone ? "" : " (in grace time)"));
				const t = new Date().getTime() - startT;
				if (graceTimeDone) ulProgress = (t + bonusT) / (settings.time_ul_max * 1000);
				if (t < 200) return;
				if (!graceTimeDone) {
					if (t > 1000 * settings.time_ulGraceTime) {
						if (totLoaded > 0) {
							// if the connection is so slow that we didn't get a single chunk yet, do not reset
							startT = new Date().getTime();
							bonusT = 0;
							totLoaded = 0.0;
						}
						graceTimeDone = true;
					}
				} else {
					const speed = totLoaded / (t / 1000.0);
					if (settings.time_auto) {
						// decide how much to shorten the test. Every 200ms, the test is shortened by the bonusT calculated here
						const bonus = 5.0 * speed / 100000;
						//bonusT += bonus > 400 ? 400 : bonus;
						bonusT = Math.min(bonusT + Math.min(bonus, 400), settings.time_ul_max - settings.time_ul_min);
					}
					// update status
					ulStatus = Number((speed * 8 * settings.overheadCompensationFactor / (settings.useMebibits ? 1048576 : 1000000)).toFixed(2)); // speed is multiplied by 8 to go from bytes to bits, overhead compensation is applied, then everything is divided by 1048576 or 1000000 to go to megabits/mebibits
					if ((t + bonusT) / 1000.0 > settings.time_ul_max || failed) {
						// test is over, stop streams and timer
						if (failed || isNaN(ulStatus)) ulStatus = -1;
						clearRequests();
						clearInterval(interval);
						ulProgress = 1;
						tlog(`ulTest: ${ulStatus < 0 ? "Fail" : ulStatus}, took ${new Date().getTime() - startT}ms`);
						done();
					}
				}
			},
			200
		);
	};
	if (settings.mpot) {
		tverb("Sending POST request before performing upload test");
		xhr = [];
		xhr[0] = new XMLHttpRequest();
		xhr[0].onload = xhr[0].onerror = () => {
			tverb("POST request sent, starting upload test");
			testFunction();
		};
		xhr[0].open("POST", settings.url_ul);
		xhr[0].send();
	} else {
		testFunction();
	}
}

let ptCalled = false; // used to prevent multiple accidental calls to pingTest
/**
 * ping+jitter test, function done is called when it's over
 * @param {() => void} done
 */
function pingTest(done) {
	tverb("pingTest");
	if (ptCalled) return;
	ptCalled = true; // pingTest already called?
	const startT = new Date().getTime(); // when the test was started
	let prevT = null; // last time a pong was received
	let ping = 0.0; // current ping value
	let jitter = 0.0; // current jitter value
	let i = 0; // counter of pongs received
	let prevInstspd = 0; // last ping time, used for jitter calculation
	xhr = [];
	// ping function
	const doPing = () => {
		tverb("ping");
		pingProgress = i / settings.count_ping;
		prevT = new Date().getTime();
		xhr[0] = new XMLHttpRequest();
		xhr[0].onload = () => {
			// pong
			tverb("pong");
			if (i === 0) {
				prevT = new Date().getTime(); // first pong
			} else {
				let instspd = new Date().getTime() - prevT;
				if (settings.ping_allowPerformanceApi) {
					try {
						// try to get accurate performance timing using performance api
						const pl = performance.getEntries();
						/** @type {PerformanceResourceTiming} */
						const p = pl[pl.length - 1];
						let d = p.responseStart - p.requestStart;
						if (d <= 0) d = p.duration;
						if (d > 0 && d < instspd) instspd = d;
					} catch (e) {
						// if not possible, keep the estimate
						tverb("Performance API not supported, using estimate");
					}
				}
				// noticed that some browsers randomly have 0ms ping
				if (instspd < 1) instspd = prevInstspd;
				if (instspd < 1) instspd = 1;
				const instjitter = Math.abs(instspd - prevInstspd);
				if (i === 1) {
					ping = instspd; // first ping, can't tell jitter yet
				} else {
					// if (instspd < ping) ping = instspd; // update ping, if the instant ping is lower
					ping += (instspd - ping) * 2 / 9; // exponential weighted moving average
					if (i === 2) jitter = instjitter; // discard the first jitter measurement because it might be much higher than it should be
					else jitter += (instjitter - jitter) * 2 / 9; // exponential weighted moving average
					// else jitter = instjitter > jitter ? jitter * 0.3 + instjitter * 0.7 : jitter * 0.8 + instjitter * 0.2; // update jitter, weighted average. spikes in ping values are given more weight.
				}
				prevInstspd = instspd;
			}
			pingStatus = Number(ping.toFixed(2));
			jitterStatus = Number(jitter.toFixed(2));
			i++;
			tverb("ping: " + pingStatus + " jitter: " + jitterStatus);
			if (i < settings.count_ping) {
				doPing();
			} else {
				// more pings to do?
				pingProgress = 1;
				tlog(`ping: ${pingStatus < 0 ? "Fail" : pingStatus} jitter: ${jitterStatus < 0 ? "Fail" : jitterStatus}, took ${new Date().getTime() - startT}ms`);
				done();
			}
		};
		xhr[0].onerror = () => {
			// a ping failed, cancel test
			tverb("ping failed");
			if (settings.xhr_ignoreErrors === 0) {
				// abort
				pingStatus = -1;
				jitterStatus = -1;
				clearRequests();
				tlog("ping test failed, took " + (new Date().getTime() - startT) + "ms");
				pingProgress = 1;
				done();
			} else if (settings.xhr_ignoreErrors === 1) {
				doPing(); // retry ping
			} else if (settings.xhr_ignoreErrors === 2) {
				// ignore failed ping
				i++;
				if (i < settings.count_ping) {
					doPing();
				} else {
					// more pings to do?
					pingProgress = 1;
					tlog(`ping: ${pingStatus < 0 ? "Fail" : pingStatus} jitter: ${jitterStatus < 0 ? "Fail" : jitterStatus}, took ${new Date().getTime() - startT}ms`);
					done();
				}
			}
		};
		// send xhr
		xhr[0].open("GET", settings.url_ping + url_sep(settings.url_ping) + (settings.mpot ? "cors=true&" : "") + "r=" + Math.random(), true); // random string to prevent caching
		xhr[0].send();
	};
	doPing(); // start first ping
}

/**
 * @param {(id?: string) => void} done
 */
function sendTelemetry(done) {
	if (settings.telemetry_level < 1) return;
	const xhr = new XMLHttpRequest();
	xhr.onload = () => {
		try {
			const parts = xhr.responseText.split(" ");
			if (parts[0] === "id")
				try {
					const id = parts[1];
					done(id);
				} catch (e) { done(null); }
			else
				done(null);
		} catch (e) { done(null); }
	};
	xhr.onerror = () => {
		console.log("TELEMETRY ERROR " + xhr.status);
		done(null);
	};
	xhr.open("POST", settings.url_telemetry + url_sep(settings.url_telemetry) + (settings.mpot ? "cors=true&" : "") + "r=" + Math.random(), true);
	const telemetryIspInfo = { processedString: clientIp, rawIspInfo: typeof ispInfo === "object" ? ispInfo : "" };
	try {
		const fd = new FormData();
		fd.append("ispinfo", JSON.stringify(telemetryIspInfo));
		fd.append("dl", dlStatus.toString());
		fd.append("ul", ulStatus.toString());
		fd.append("ping", pingStatus.toString());
		fd.append("jitter", jitterStatus.toString());
		fd.append("log", settings.telemetry_level > 1 ? log : "");
		fd.append("extra", settings.telemetry_extra);
		xhr.send(fd);
	} catch (ex) {
		const postData = "extra=" + encodeURIComponent(settings.telemetry_extra) + "&ispinfo=" + encodeURIComponent(JSON.stringify(telemetryIspInfo)) + "&dl=" + encodeURIComponent(dlStatus) + "&ul=" + encodeURIComponent(ulStatus) + "&ping=" + encodeURIComponent(pingStatus) + "&jitter=" + encodeURIComponent(jitterStatus) + "&log=" + encodeURIComponent(settings.telemetry_level > 1 ? log : "");
		xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
		xhr.send(postData);
	}
}

/**
 * this function is used on URLs passed in the settings to determine whether we need a '?' or an '&' as a separator
 * @param {string} url
 */
function url_sep(url) {
	return url.match(/\?/) ? "&" : "?";
}
