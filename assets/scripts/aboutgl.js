/* ── Globe canvas — interactive high-quality vector earth ── */
(function () {
    var canvas = document.getElementById('globe-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var BREAKPOINT = 720;

    /* ── Rotation state ──────────────────────────────── */
    var angle = -80;
    var tilt = 18;
    var cx, cy, r;

    /* ── Drag / interaction state ────────────────────── */
    var isDragging = false;
    var lastPointerX = 0;
    var lastPointerY = 0;
    var velX = 0;
    var velY = 0;
    var lastMoveTime = 0;
    var autoRotate = true;
    var resumeTimer = null;
    var isMobile = window.innerWidth < BREAKPOINT;

    var SENS_X = 0.18;
    var SENS_Y = 0.12;
    var MAX_TILT = 75;
    var FRICTION = 0.955;
    var AUTO_SPEED = 0.05;
    var RESUME_MS = 1000;
    var VEL_STOP = 0.003;

    /* ── Real-earth data (loaded from CDN, falls back to hand-drawn) ── */
    var landCountries = null;   /* [{ rings: [[[lat,lon],...], ...holes] }] */
    var DATA_URLS = [
        'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json',
        'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json'
    ];

    function decodeTopology(topo) {
        if (!topo || !topo.transform || !topo.objects || !topo.objects.countries) return null;
        var sx = topo.transform.scale[0], sy = topo.transform.scale[1];
        var tx = topo.transform.translate[0], ty = topo.transform.translate[1];
        var arcsRaw = topo.arcs.map(function (arc) {
            var x = 0, y = 0, out = [];
            for (var i = 0; i < arc.length; i++) {
                x += arc[i][0]; y += arc[i][1];
                out.push([y * sy + ty, x * sx + tx]); /* [lat, lon] */
            }
            return out;
        });
        function ring(arcIdxs) {
            var pts = [];
            for (var i = 0; i < arcIdxs.length; i++) {
                var idx = arcIdxs[i];
                var rev = idx < 0;
                var arc = arcsRaw[rev ? ~idx : idx].slice();
                if (rev) arc.reverse();
                if (pts.length > 0) arc.shift();
                pts = pts.concat(arc);
            }
            return pts;
        }
        function geomToPolys(geom) {
            if (!geom) return [];
            if (geom.type === 'Polygon') return [{ rings: geom.arcs.map(ring) }];
            if (geom.type === 'MultiPolygon') {
                return geom.arcs.map(function (poly) { return { rings: poly.map(ring) }; });
            }
            return [];
        }
        var geoms = topo.objects.countries.geometries || [topo.objects.countries];
        var countries = [];
        for (var g = 0; g < geoms.length; g++) {
            var polys = geomToPolys(geoms[g]);
            for (var p = 0; p < polys.length; p++) countries.push(polys[p]);
        }
        return countries.length ? countries : null;
    }

    function loadEarthData() {
        var attempt = 0;
        function tryNext() {
            if (attempt >= DATA_URLS.length) return;
            var url = DATA_URLS[attempt++];
            fetch(url)
                .then(function (res) { if (!res.ok) throw new Error('http'); return res.json(); })
                .then(function (topo) {
                    var decoded = decodeTopology(topo);
                    if (decoded) landCountries = decoded; else throw new Error('decode');
                })
                .catch(function () { tryNext(); });
        }
        tryNext();
    }
    loadEarthData();

    /* ── Fallback: simplified continent outlines ─────── */
    var continents = [
        [[71, -157], [72, -152], [72, -146], [72, -140], [71, -134], [70, -128], [70, -122], [69, -115], [68, -108], [67, -102], [66, -96], [65, -90], [64, -85], [62, -79], [60, -74], [58, -68], [56, -63], [54, -58], [52, -56], [50, -57], [48, -59], [46, -62], [44, -65], [43, -68], [42, -70], [41, -72], [40, -74], [38, -76], [37, -76], [35, -77], [34, -78], [32, -80], [31, -81], [30, -81], [29, -82], [28, -83], [27, -82], [26, -82], [25, -81], [25, -83], [26, -85], [27, -86], [28, -88], [29, -90], [29, -92], [28, -94], [27, -95], [26, -97], [24, -98], [22, -98], [20, -97], [19, -96], [18, -95], [17, -93], [16, -91], [15, -89], [15, -87], [16, -88], [16, -91], [17, -95], [18, -98], [19, -101], [20, -104], [22, -107], [24, -110], [26, -112], [28, -114], [30, -116], [32, -117], [34, -119], [36, -121], [38, -123], [40, -124], [42, -124], [44, -125], [47, -125], [49, -127], [51, -130], [53, -133], [55, -136], [57, -139], [59, -143], [60, -147], [62, -150], [63, -154], [64, -158], [65, -162], [66, -165], [68, -166], [70, -164], [71, -160], [71, -157]],
        [[12, -72], [11, -69], [10, -66], [9, -63], [8, -60], [7, -57], [6, -54], [5, -52], [4, -50], [2, -48], [0, -46], [-1, -44], [-3, -41], [-5, -38], [-7, -35], [-9, -35], [-11, -37], [-13, -39], [-15, -40], [-17, -41], [-19, -42], [-21, -43], [-23, -45], [-25, -47], [-27, -49], [-29, -51], [-31, -53], [-33, -55], [-35, -57], [-37, -59], [-39, -61], [-41, -63], [-43, -64], [-45, -66], [-47, -67], [-49, -68], [-51, -69], [-53, -69], [-54, -68], [-55, -66], [-54, -64], [-53, -66], [-52, -69], [-50, -72], [-48, -74], [-46, -75], [-44, -74], [-42, -73], [-40, -72], [-38, -71], [-36, -70], [-34, -70], [-32, -70], [-30, -70], [-28, -69], [-26, -69], [-24, -70], [-22, -71], [-20, -72], [-18, -73], [-16, -75], [-14, -76], [-12, -77], [-10, -78], [-8, -79], [-6, -80], [-4, -80], [-2, -79], [0, -78], [2, -78], [4, -77], [6, -76], [8, -75], [10, -74], [12, -72]],
        [[71, 28], [71, 30], [70, 33], [70, 36], [70, 40], [69, 42], [68, 44], [67, 44], [65, 43], [63, 42], [61, 41], [59, 41], [57, 40], [55, 40], [53, 40], [51, 40], [49, 41], [47, 41], [45, 40], [44, 40], [43, 42], [42, 43], [41, 40], [40, 37], [39, 33], [38, 28], [37, 24], [37, 20], [38, 16], [38, 14], [39, 12], [40, 14], [41, 12], [42, 10], [43, 8], [44, 7], [45, 5], [46, 4], [47, 3], [48, 2], [49, 2], [50, 4], [51, 5], [52, 6], [53, 8], [54, 9], [55, 10], [56, 12], [57, 11], [58, 10], [59, 8], [60, 6], [61, 5], [62, 6], [63, 8], [64, 10], [65, 13], [66, 16], [67, 18], [68, 20], [69, 22], [70, 25], [71, 28]],
        [[37, 10], [36, 6], [35, 2], [34, -2], [33, -5], [32, -8], [31, -10], [29, -12], [27, -14], [25, -16], [23, -17], [21, -17], [19, -17], [17, -17], [15, -17], [13, -16], [11, -15], [9, -14], [7, -12], [6, -10], [5, -8], [4, -5], [4, -2], [4, 0], [4, 3], [3, 6], [2, 9], [0, 10], [-2, 10], [-4, 11], [-6, 12], [-8, 13], [-10, 14], [-12, 15], [-14, 16], [-16, 17], [-18, 18], [-20, 20], [-22, 22], [-24, 24], [-26, 26], [-28, 28], [-30, 28], [-32, 27], [-34, 25], [-35, 22], [-34, 20], [-33, 22], [-32, 25], [-30, 28], [-28, 31], [-26, 33], [-24, 35], [-22, 36], [-20, 37], [-18, 38], [-16, 39], [-14, 40], [-12, 41], [-10, 42], [-8, 43], [-6, 44], [-4, 44], [-2, 44], [0, 44], [2, 45], [4, 46], [6, 47], [8, 48], [10, 50], [12, 51], [14, 49], [16, 46], [18, 44], [19, 42], [20, 40], [22, 38], [24, 36], [26, 34], [28, 33], [30, 32], [32, 30], [34, 28], [36, 25], [37, 20], [37, 15], [37, 10]],
        [[70, 42], [71, 48], [72, 55], [73, 62], [73, 70], [74, 78], [74, 85], [75, 92], [75, 100], [74, 108], [73, 115], [72, 120], [72, 128], [71, 135], [70, 140], [68, 148], [67, 155], [66, 160], [64, 165], [62, 168], [60, 165], [58, 160], [56, 158], [54, 155], [52, 148], [50, 143], [48, 143], [46, 143], [44, 142], [42, 140], [40, 136], [38, 132], [36, 128], [34, 125], [32, 122], [30, 120], [28, 118], [26, 116], [24, 114], [22, 112], [20, 110], [18, 108], [16, 106], [14, 105], [12, 105], [10, 104], [8, 104], [6, 104], [4, 104], [2, 103], [1, 104], [3, 100], [5, 98], [7, 97], [9, 96], [12, 95], [15, 94], [17, 93], [19, 91], [20, 89], [19, 86], [18, 83], [16, 80], [14, 78], [12, 76], [10, 76], [8, 76], [6, 76], [5, 75], [8, 74], [12, 73], [16, 72], [20, 72], [24, 70], [27, 68], [30, 66], [32, 64], [34, 62], [36, 58], [38, 54], [40, 50], [42, 46], [44, 42], [46, 40], [48, 40], [50, 40], [52, 40], [54, 40], [56, 40], [58, 42], [60, 42], [62, 42], [64, 42], [66, 42], [68, 42], [70, 42]],
        [[-12, 131], [-13, 128], [-15, 125], [-17, 122], [-19, 119], [-21, 116], [-23, 115], [-25, 114], [-27, 114], [-29, 115], [-31, 116], [-33, 117], [-34, 119], [-35, 121], [-36, 124], [-37, 128], [-37, 132], [-38, 136], [-38, 140], [-38, 144], [-37, 148], [-36, 150], [-34, 151], [-32, 152], [-30, 153], [-28, 153], [-26, 152], [-24, 151], [-22, 149], [-20, 147], [-18, 145], [-16, 143], [-14, 140], [-13, 137], [-12, 134], [-12, 131]],
        [[76, -72], [77, -66], [78, -60], [79, -53], [80, -46], [81, -38], [82, -30], [82, -24], [81, -20], [80, -18], [78, -20], [76, -24], [74, -28], [72, -32], [70, -36], [68, -40], [66, -44], [65, -48], [64, -52], [64, -56], [65, -58], [67, -60], [69, -62], [71, -64], [73, -66], [75, -68], [76, -72]],
        [[66, -24], [66, -20], [65, -18], [64, -16], [64, -18], [64, -22], [65, -24], [66, -24]],
        [[58, -6], [59, -4], [59, -2], [58, 0], [57, 0], [56, -1], [55, -2], [54, -3], [53, -4], [52, -5], [51, -5], [50, -5], [51, -4], [52, -3], [53, -2], [54, -1], [55, 0], [56, 0], [57, -1], [58, -3], [58, -6]],
        [[45, 142], [44, 144], [43, 145], [42, 144], [41, 142], [40, 140], [39, 138], [38, 136], [37, 134], [36, 133], [35, 132], [34, 131], [33, 130], [34, 129], [35, 130], [36, 132], [37, 134], [39, 137], [41, 140], [43, 142], [45, 142]],
        [[-35, 174], [-37, 175], [-39, 177], [-41, 176], [-42, 174], [-41, 173], [-39, 175], [-37, 176], [-36, 175], [-35, 174]],
        [[-42, 171], [-43, 172], [-45, 170], [-46, 167], [-45, 168], [-44, 170], [-43, 171], [-42, 171]],
        [[5, 95], [4, 97], [3, 99], [1, 101], [-1, 103], [-2, 105], [-3, 105], [-3, 103], [-2, 100], [0, 97], [2, 95], [4, 94], [5, 95]],
        [[4, 109], [3, 111], [2, 113], [0, 115], [-1, 116], [-2, 116], [-2, 114], [-1, 112], [0, 110], [2, 108], [4, 109]],
        [[-6, 106], [-7, 108], [-7, 110], [-8, 112], [-8, 114], [-7, 115], [-6, 114], [-6, 112], [-6, 108], [-6, 106]],
        [[-2, 140], [-3, 141], [-5, 142], [-6, 144], [-7, 146], [-8, 148], [-8, 150], [-7, 151], [-6, 150], [-5, 148], [-4, 146], [-3, 144], [-2, 142], [-1, 141], [-2, 140]],
        [[1, 120], [0, 121], [-1, 122], [-2, 121], [-3, 120], [-2, 119], [-1, 119], [0, 119], [1, 120]],
        [[-12, 49], [-14, 50], [-16, 50], [-18, 49], [-20, 48], [-22, 47], [-24, 46], [-25, 45], [-24, 44], [-22, 44], [-20, 44], [-18, 45], [-16, 46], [-14, 47], [-12, 49]],
        [[10, 80], [9, 80], [8, 80], [7, 80], [6, 80], [6, 81], [7, 82], [8, 82], [9, 81], [10, 80]],
        [[25, 121], [24, 121], [23, 121], [22, 121], [22, 120], [23, 120], [24, 120], [25, 121]],
        [[18, 120], [17, 121], [16, 121], [15, 121], [14, 121], [15, 120], [16, 120], [17, 120], [18, 120]],
        [[10, 124], [9, 125], [8, 126], [7, 126], [7, 125], [8, 124], [9, 124], [10, 124]],
        [[38, 128], [37, 127], [36, 127], [35, 127], [34, 128], [35, 129], [36, 129], [37, 129], [38, 128]],
        [[71, 26], [70, 22], [69, 18], [68, 15], [67, 14], [66, 13], [65, 12], [64, 11], [63, 9], [62, 7], [61, 6], [60, 5], [59, 5], [58, 6], [58, 8], [59, 10], [60, 12], [61, 14], [62, 16], [63, 18], [64, 20], [65, 22], [66, 24], [67, 26], [68, 28], [69, 30], [70, 32], [71, 28]],
        [[46, 7], [45, 8], [44, 9], [43, 11], [42, 12], [41, 14], [40, 16], [39, 17], [38, 16], [38, 15], [39, 13], [40, 12], [41, 11], [42, 10], [43, 9], [44, 8], [45, 7], [46, 7]],
        [[30, 35], [28, 36], [26, 37], [24, 38], [22, 39], [20, 40], [18, 42], [16, 43], [14, 44], [13, 45], [12, 44], [13, 43], [15, 42], [17, 41], [19, 40], [21, 39], [23, 38], [25, 37], [27, 36], [29, 35], [30, 35]],
        [[30, 68], [28, 70], [26, 72], [24, 73], [22, 73], [20, 73], [18, 73], [16, 74], [14, 75], [12, 76], [10, 77], [8, 77], [8, 76], [10, 76], [12, 75], [14, 74], [16, 73], [18, 72], [20, 72], [22, 72], [24, 72], [26, 72], [28, 70], [30, 68]],
        [[55, 160], [56, 162], [57, 163], [58, 163], [59, 162], [60, 163], [61, 164], [62, 163], [63, 162], [62, 161], [61, 160], [60, 159], [59, 158], [58, 159], [57, 160], [56, 160], [55, 160]],
        [[22, -84], [21, -82], [20, -78], [20, -76], [21, -75], [22, -77], [23, -80], [23, -82], [22, -84]],
        [[20, -72], [19, -71], [18, -70], [18, -72], [19, -73], [20, -73], [20, -72]],
        [[73, -80], [72, -75], [71, -70], [70, -65], [69, -62], [68, -63], [68, -67], [69, -72], [70, -76], [71, -79], [73, -80]]
    ];

    var cities = [
        [40.7, -74], [51.5, -0.1], [48.9, 2.3], [55.8, 37.6], [35.7, 139.7],
        [39.9, 116.4], [28.6, 77.2], [-23.5, -46.6], [-33.9, 151.2], [19.4, -99.1],
        [30, 31.2], [1.3, 103.8], [-6.2, 106.8], [37.6, 127], [34.1, -118.2],
        [41.9, -87.6], [52.5, 13.4], [59.3, 18.1], [45.5, -73.6], [22.3, 114.2]
    ];

    var connections = [
        [0, 1], [0, 14], [0, 15], [1, 2], [1, 16], [1, 17], [2, 3], [2, 16],
        [3, 4], [3, 5], [4, 5], [4, 13], [5, 19], [5, 11], [6, 10], [6, 11],
        [7, 8], [8, 19], [9, 14], [10, 3], [12, 11], [13, 4], [15, 0], [16, 17],
        [18, 0], [19, 12]
    ];

    /* ── 3D projection with tilt ─────────────────────── */
    function project(lat, lon) {
        var latR = lat * Math.PI / 180;
        var lonR = (lon - angle) * Math.PI / 180;
        var tiltR = tilt * Math.PI / 180;
        var x3 = Math.cos(latR) * Math.sin(lonR);
        var y3 = Math.sin(latR);
        var z3 = Math.cos(latR) * Math.cos(lonR);
        var yT = y3 * Math.cos(tiltR) - z3 * Math.sin(tiltR);
        var zT = y3 * Math.sin(tiltR) + z3 * Math.cos(tiltR);
        return { x: cx + r * x3, y: cy - r * yT, z: zT, lat: lat, lon: lon };
    }

    function edgePoint(p1, p2) {
        var dz = p1.z - p2.z;
        if (Math.abs(dz) < 1e-6) return null;
        var t = p1.z / dz;
        return project(p1.lat + t * (p2.lat - p1.lat), p1.lon + t * (p2.lon - p1.lon));
    }

    /* ── Smooth Catmull-Rom path ─────────────────────── */
    function traceSmoothPath(pts) {
        if (pts.length < 2) return;
        if (pts.length === 2) { ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); return; }
        ctx.moveTo(pts[0].x, pts[0].y);
        var T = 5;
        for (var i = 0; i < pts.length - 1; i++) {
            var p0 = pts[i === 0 ? 0 : i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2 >= pts.length ? pts.length - 1 : i + 2];
            ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / T, p1.y + (p2.y - p0.y) / T, p2.x - (p3.x - p1.x) / T, p2.y - (p3.y - p1.y) / T, p2.x, p2.y);
        }
    }

    /* ── Drawing helpers ─────────────────────────────── */
    function drawGrid() {
        ctx.strokeStyle = 'rgba(60,120,110,0.07)'; ctx.lineWidth = 0.5;
        for (var lat = -60; lat <= 60; lat += 30) { ctx.beginPath(); var s = false; for (var lon = -180; lon <= 180; lon += 3) { var p = project(lat, lon); if (p.z > 0) { if (!s) { ctx.moveTo(p.x, p.y); s = true; } else ctx.lineTo(p.x, p.y); } else s = false; } ctx.stroke(); }
        for (var lon2 = -180; lon2 < 180; lon2 += 30) { ctx.beginPath(); var s2 = false; for (var lat2 = -90; lat2 <= 90; lat2 += 3) { var p2 = project(lat2, lon2); if (p2.z > 0) { if (!s2) { ctx.moveTo(p2.x, p2.y); s2 = true; } else ctx.lineTo(p2.x, p2.y); } else s2 = false; } ctx.stroke(); }
    }

    function drawEquator() {
        ctx.beginPath(); var s = false;
        for (var lon = -180; lon <= 180; lon += 2) { var p = project(0, lon); if (p.z > 0) { if (!s) { ctx.moveTo(p.x, p.y); s = true; } else ctx.lineTo(p.x, p.y); } else s = false; }
        ctx.strokeStyle = 'rgba(60,120,110,0.14)'; ctx.lineWidth = 0.7; ctx.stroke();
    }

    function drawArcs() {
        for (var ci = 0; ci < connections.length; ci++) {
            var pair = connections[ci], c1 = cities[pair[0]], c2 = cities[pair[1]];
            var p1 = project(c1[0], c1[1]), p2 = project(c2[0], c2[1]);
            if (p1.z < 0.1 || p2.z < 0.1) continue;
            var dist = Math.sqrt(Math.pow(c1[0] - c2[0], 2) + Math.pow(c1[1] - c2[1], 2));
            var pM = project((c1[0] + c2[0]) / 2 + Math.min(dist * 0.35, 28), (c1[1] + c2[1]) / 2);
            var avgZ = (p1.z + p2.z) / 2;
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y);
            if (pM.z > 0) ctx.quadraticCurveTo(pM.x, pM.y, p2.x, p2.y); else ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = 'rgba(35,154,77,' + (0.04 + 0.06 * avgZ).toFixed(3) + ')'; ctx.lineWidth = 0.6; ctx.stroke();
        }
    }

    /* ── Horizon-aware ring tracing ──────────────────── */
    function keepPt(cur, p) {
        /* Decimate: skip points closer than ~0.6px to the previous one */
        if (!cur.length) return true;
        var q = cur[cur.length - 1];
        var dx = p.x - q.x, dy = p.y - q.y;
        return dx * dx + dy * dy > 0.36;
    }

    function collectVisibleSegs(pts) {
        var n = pts.length;
        if (n < 3) return [];
        var proj = new Array(n);
        for (var i = 0; i < n; i++) proj[i] = project(pts[i][0], pts[i][1]);
        var segs = [], cur = [];
        for (var j = 0; j < n; j++) {
            var p = proj[j], pn = proj[(j + 1) % n];
            if (p.z > 0 && keepPt(cur, p)) cur.push(p);
            if (p.z > 0 && pn.z <= 0) { var ep = edgePoint(p, pn); if (ep) cur.push(ep); if (cur.length > 1) segs.push(cur); cur = []; }
            else if (p.z <= 0 && pn.z > 0) { var ep2 = edgePoint(p, pn); cur = ep2 ? [ep2] : []; }
        }
        if (cur.length > 0 && segs.length > 0) segs[0] = cur.concat(segs[0]);
        else if (cur.length > 1) segs.push(cur);
        return segs;
    }

    function traceRing(pts) {
        var segs = collectVisibleSegs(pts);
        for (var si = 0; si < segs.length; si++) {
            var seg = segs[si];
            ctx.beginPath();
            ctx.moveTo(seg[0].x, seg[0].y);
            for (var k = 1; k < seg.length; k++) ctx.lineTo(seg[k].x, seg[k].y);
            ctx.stroke();
        }
    }

    function fillCountry(polys, evenodd) {
        /* Build one combined path of visible segments per polygon */
        ctx.beginPath();
        for (var pi = 0; pi < polys.length; pi++) {
            var rings = polys[pi].rings;
            for (var ri = 0; ri < rings.length; ri++) {
                var segs = collectVisibleSegs(rings[ri]);
                for (var si = 0; si < segs.length; si++) {
                    var seg = segs[si];
                    ctx.moveTo(seg[0].x, seg[0].y);
                    for (var k = 1; k < seg.length; k++) ctx.lineTo(seg[k].x, seg[k].y);
                    ctx.closePath();
                }
            }
        }
        ctx.fill(evenodd ? 'evenodd' : 'nonzero');
    }

    function drawRealEarth() {
        /* Fill all countries */
        ctx.fillStyle = 'rgba(46,160,92,0.32)';
        for (var c = 0; c < landCountries.length; c++) fillCountry([landCountries[c]], false);
        /* Country borders + coastline strokes */
        ctx.strokeStyle = 'rgba(21,120,66,0.45)';
        ctx.lineWidth = 0.8;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (var d = 0; d < landCountries.length; d++) {
            var polys = [landCountries[d]];
            for (var pi = 0; pi < polys.length; pi++) {
                for (var ri = 0; ri < polys[pi].rings.length; ri++) traceRing(polys[pi].rings[ri]);
            }
        }
    }

    function drawLegacyEarth() {
        var legacy = [];
        for (var ci = 0; ci < continents.length; ci++) {
            var rings = continents[ci].map(function (pt) { return [pt[0], pt[1]]; });
            legacy.push({ rings: [rings] });
        }
        ctx.fillStyle = 'rgba(46,160,92,0.28)';
        for (var f = 0; f < legacy.length; f++) fillCountry([legacy[f]], false);
        ctx.strokeStyle = 'rgba(21,120,66,0.42)';
        ctx.lineWidth = 0.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (var s = 0; s < legacy.length; s++) {
            for (var ri = 0; ri < legacy[s].rings.length; ri++) traceRing(legacy[s].rings[ri]);
        }
    }

    function drawContinents() {
        if (landCountries) drawRealEarth();
        else drawLegacyEarth();
    }

    function drawCities() {
        for (var i = 0; i < cities.length; i++) {
            var p = project(cities[i][0], cities[i][1]); if (p.z < 0.12) continue;
            var glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 6);
            glow.addColorStop(0, 'rgba(35,154,77,' + (0.18 * p.z).toFixed(3) + ')'); glow.addColorStop(1, 'rgba(35,154,77,0)');
            ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fillStyle = glow; ctx.fill();
            ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.8, 1.5 * p.z), 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(35,154,77,' + (0.3 + 0.45 * p.z).toFixed(3) + ')'; ctx.fill();
        }
    }

    /* ── Pointer handlers ────────────────────────────── */
    function getPointerPos(e) {
        if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        return { x: e.clientX, y: e.clientY };
    }

    function onPointerDown(e) {
        isDragging = true; var pos = getPointerPos(e);
        lastPointerX = pos.x; lastPointerY = pos.y; velX = 0; velY = 0;
        lastMoveTime = performance.now(); canvas.style.cursor = 'grabbing';
        autoRotate = false; if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    }

    function onPointerMove(e) {
        if (!isDragging) return; e.preventDefault(); var pos = getPointerPos(e);
        var dx = pos.x - lastPointerX, dy = pos.y - lastPointerY;
        var now = performance.now(), dt = Math.max(1, now - lastMoveTime);
        angle -= dx * SENS_X; tilt += dy * SENS_Y; tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, tilt));
        velX = -dx * SENS_X / dt * 16; velY = dy * SENS_Y / dt * 16;
        lastPointerX = pos.x; lastPointerY = pos.y; lastMoveTime = now;
    }

    function onPointerUp() {
        if (!isDragging) return; isDragging = false;
        canvas.style.cursor = 'grab';
        resumeTimer = setTimeout(function () { autoRotate = true; }, RESUME_MS);
    }

    function preventCtx(e) { e.preventDefault(); }

    /* ── Dynamic touch listener management ───────────── */
    var touchAttached = false;

    function attachTouch() {
        if (touchAttached) return;
        canvas.addEventListener('touchstart', onPointerDown, { passive: false });
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp);
        canvas.addEventListener('contextmenu', preventCtx);
        touchAttached = true;
    }

    function detachTouch() {
        if (!touchAttached) return;
        canvas.removeEventListener('touchstart', onPointerDown);
        window.removeEventListener('touchmove', onPointerMove);
        window.removeEventListener('touchend', onPointerUp);
        canvas.removeEventListener('contextmenu', preventCtx);
        touchAttached = false;
    }

    /* ── Mode switch: called on load + every resize ──── */
    function applyMode() {
        var wasMobile = isMobile;
        isMobile = window.innerWidth < BREAKPOINT;

        /* Crossed the breakpoint — reset drag state */
        if (wasMobile !== isMobile) {
            isDragging = false; velX = 0; velY = 0;
            if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        }

        if (isMobile) {
            canvas.style.touchAction = 'auto';
            canvas.style.cursor = 'default';
            autoRotate = true;
            detachTouch();
        } else {
            canvas.style.touchAction = 'none';
            canvas.style.cursor = 'grab';
            attachTouch();
        }
    }

    /* Mouse — always on (doesn't fire on phones) */
    canvas.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);

    /* Initial mode + live resize */
    applyMode();
    window.addEventListener('resize', applyMode, { passive: true });

    /* ── Main render loop ────────────────────────────── */
    var rafId = null;
    var onScreen = true;

    function draw() {
        rafId = null;
        /* Skip all work when the canvas is hidden (e.g. the account
           dashboard replaces the login shell) or the tab is inactive. */
        if (!onScreen || document.hidden) return;

        var w = canvas.offsetWidth, h = canvas.offsetHeight;

        /* Safety: force canvas to fill parent */
        if (canvas.parentElement) {
            var pw = canvas.parentElement.clientWidth, ph = canvas.parentElement.clientHeight;
            if (pw > 0 && ph > 0) {
                canvas.style.width = pw + 'px';
                canvas.style.height = ph + 'px';
                w = pw; h = ph;
            }
        }
        if (w < 10) w = 300;
        if (h < 10) h = 300;

        var needW = Math.round(w * dpr), needH = Math.round(h * dpr);
        if (canvas.width !== needW || canvas.height !== needH) { canvas.width = needW; canvas.height = needH; }

        if (!isDragging && !autoRotate) {
            angle += velX; tilt += velY; tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, tilt));
            velX *= FRICTION; velY *= FRICTION;
            if (Math.abs(velX) < VEL_STOP) velX = 0; if (Math.abs(velY) < VEL_STOP) velY = 0;
        }
        if (autoRotate) angle += AUTO_SPEED;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        cx = w / 2; cy = h / 2; r = Math.min(cx, cy) * 0.97;

        /* Drop shadow */
        var sGrd = ctx.createRadialGradient(cx + 2, cy + 4, r * 0.7, cx + 2, cy + 4, r * 1.25);
        sGrd.addColorStop(0, 'rgba(35,154,77,0.035)'); sGrd.addColorStop(1, 'rgba(35,154,77,0)');
        ctx.beginPath(); ctx.arc(cx + 2, cy + 4, r * 1.25, 0, Math.PI * 2); ctx.fillStyle = sGrd; ctx.fill();

        /* Atmospheric glow */
        for (var gi = 3; gi >= 1; gi--) {
            var gR = r + gi * 10;
            var aG = ctx.createRadialGradient(cx, cy, r - 2, cx, cy, gR);
            aG.addColorStop(0, 'rgba(35,154,77,0)'); aG.addColorStop(0.4, 'rgba(35,154,77,' + (0.025 * gi).toFixed(3) + ')'); aG.addColorStop(1, 'rgba(35,154,77,0)');
            ctx.beginPath(); ctx.arc(cx, cy, gR, 0, Math.PI * 2); ctx.fillStyle = aG; ctx.fill();
        }

        /* Clip to sphere */
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();

        /* Ocean gradient — soft blue-green, lighter toward the sun */
        var oG = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.05, cx, cy, r);
        oG.addColorStop(0, '#eef7f3');
        oG.addColorStop(0.55, '#e2f1ec');
        oG.addColorStop(1, '#cfe6df');
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = oG; ctx.fill();

        /* Subtle depth tint near the limb (fakes sphere curvature) */
        var lG = ctx.createRadialGradient(cx, cy, r * 0.72, cx, cy, r);
        lG.addColorStop(0, 'rgba(120,170,155,0)');
        lG.addColorStop(1, 'rgba(90,145,130,0.16)');
        ctx.fillStyle = lG; ctx.fillRect(0, 0, w, h);

        drawGrid(); drawEquator(); drawArcs(); drawContinents(); drawCities();
        ctx.restore();

        /* Specular highlight (sun reflection top-left) */
        var spG = ctx.createRadialGradient(cx - r * 0.42, cy - r * 0.45, 0, cx - r * 0.42, cy - r * 0.45, r * 0.75);
        spG.addColorStop(0, 'rgba(255,255,255,0.35)');
        spG.addColorStop(0.25, 'rgba(255,255,255,0.12)');
        spG.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = spG; ctx.fill();

        /* 3D shading + limb darkening */
        var shG = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.05, cx + r * 0.1, cy + r * 0.1, r * 1.1);
        shG.addColorStop(0, 'rgba(255,255,255,0.06)');
        shG.addColorStop(0.35, 'rgba(255,255,255,0.01)');
        shG.addColorStop(0.7, 'rgba(30,60,50,0.03)');
        shG.addColorStop(1, 'rgba(20,50,40,0.12)');
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = shG; ctx.fill();

        /* Rings */
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(35,154,77,0.2)'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, r - 0.8, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 0.5; ctx.stroke();

        /* Edge fade */
        var eG = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
        eG.addColorStop(0, 'rgba(244,249,245,0)'); eG.addColorStop(1, 'rgba(244,249,245,0.4)');
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = eG; ctx.fill();

        rafId = requestAnimationFrame(draw);
    }

    function start() {
        if (rafId !== null || !onScreen || document.hidden) return;
        rafId = requestAnimationFrame(draw);
    }

    function stop() {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    /* Pause when the canvas leaves the viewport or is display:none
       (IntersectionObserver reports hidden elements as not intersecting). */
    if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (entries) {
            onScreen = entries[0].isIntersecting;
            if (onScreen) start(); else stop();
        }, { threshold: 0 }).observe(canvas);
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stop(); else start();
    });

    start();
})();

/* ── Globe box — responsive sizing (mobile + desktop) ─── */
(function () {
    var section = document.getElementById('globe-section');
    var box = document.getElementById('globe-box');
    if (!section || !box) return;
    var BREAKPOINT = 720;

    function update() {
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var canvas = box.querySelector('canvas');

        if (vw < BREAKPOINT) {
            /* ── Mobile: fixed square, centered ───────── */
            var size = Math.min(vw - 32, 400);
            box.style.width = size + 'px';
            box.style.height = size + 'px';
            box.style.margin = '0 auto';
            box.style.position = 'relative';
            box.style.borderRadius = '16px';
            box.style.overflow = 'hidden';
        } else {
            /* ── Desktop: scroll-driven expand ────────── */
            var rect = section.getBoundingClientRect();
            var scroll = -rect.top;
            var progress = Math.max(0, Math.min(1, scroll / vh));
            var ease = progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;

            var minW = Math.min(760, vw - 48);
            var maxW = vw;
            var minH = 520;
            var maxH = vh;

            box.style.width = (minW + (maxW - minW) * ease) + 'px';
            box.style.height = (minH + (maxH - minH) * ease) + 'px';
            box.style.borderRadius = (20 * (1 - ease)) + 'px';
            box.style.margin = '';
            box.style.position = '';
            box.style.overflow = '';
        }

        /* Always ensure canvas fills the box */
        if (canvas) {
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.display = 'block';
        }
    }

    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
})();

/* ── NAVBAR: transparent at top, solid when scrolled ──── */
(function () {
    var navbar = document.querySelector('.navbar');
    if (!navbar) return;
    var ENTER_THRESHOLD = 20;
    var EXIT_THRESHOLD = 120;

    function syncNavState() {
        var y = window.scrollY;
        var isAtTop = navbar.classList.contains('nav-at-top');
        if (isAtTop && y > EXIT_THRESHOLD) navbar.classList.remove('nav-at-top');
        else if (!isAtTop && y <= ENTER_THRESHOLD) navbar.classList.add('nav-at-top');
    }

    var ticking = false;
    function onScroll() { if (ticking) return; ticking = true; requestAnimationFrame(function () { syncNavState(); ticking = false; }); }
    window.addEventListener('scroll', onScroll, { passive: true });
    syncNavState();
})();