// Themes: the list, applying one, and the Matrix rain. Loaded early so the page never flashes the wrong colours.
(function () {
  var T = [
    { id: 'dark', name: 'Dark', note: 'The default dark look', dark: true, sw: ['#0e1116', '#1c232d', '#f5b83d'] },
    { id: 'light', name: 'Bright', note: 'The default bright look', dark: false, sw: ['#f4f5f7', '#ffffff', '#f5b83d'] },
    { id: 'matrix', name: 'Matrix', note: 'Green on black, with falling code', dark: true, sw: ['#020a04', '#04200c', '#00ff41'] },
    { id: 'glass', name: 'Glass', note: 'Frosted glass over a soft wallpaper', dark: false, sw: ['#cfe0ff', '#ffffff', '#0066d6'] },
    { id: 'glass-dark', name: 'Glass Dark', note: 'Frosted glass at night', dark: true, sw: ['#14122e', '#2a2f4a', '#4da3ff'] },
    { id: 'nord', name: 'Nord', note: 'Calm arctic blues', dark: true, sw: ['#2e3440', '#434c5e', '#88c0d0'] },
    { id: 'tokyo', name: 'Tokyo Night', note: 'Deep indigo with soft neon', dark: true, sw: ['#1a1b26', '#24283b', '#7aa2f7'] },
    { id: 'dracula', name: 'Dracula', note: 'Purple and pink on charcoal', dark: true, sw: ['#282a36', '#3a3d4f', '#bd93f9'] },
    { id: 'solarized', name: 'Solarized Light', note: 'Warm paper, easy on the eyes', dark: false, sw: ['#fdf6e3', '#fffbee', '#1a6fb0'] },
    { id: 'graphite', name: 'Graphite', note: 'Neutral and businesslike', dark: false, sw: ['#f1f2f4', '#ffffff', '#4f46e5'] },
    { id: 'contrast', name: 'High contrast', note: 'Maximum legibility', dark: true, sw: ['#000000', '#141414', '#ffd60a'] }
  ];
  var byId = {}; T.forEach(function (t) { byId[t.id] = t; });
  window.APIARY_THEMES = T;
  var rain = null;

  function stopRain() { if (rain) { clearInterval(rain.timer); rain.canvas.remove(); removeEventListener('resize', rain.size); rain = null; } }
  function startRain() {
    if (rain || (matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    var c = document.createElement('canvas'); c.id = 'rain'; c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;opacity:.3';
    document.body.prepend(c);
    var x = c.getContext('2d'), fs = 16, drops = [], chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';
    function size() { c.width = innerWidth; c.height = innerHeight; drops = []; for (var i = 0; i < Math.ceil(c.width / fs); i++) drops.push(Math.random() * -50); }
    size(); addEventListener('resize', size);
    var timer = setInterval(function () {
      if (document.hidden) return;
      x.fillStyle = 'rgba(0,8,2,.12)'; x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = '#00ff41'; x.font = fs + 'px monospace';
      for (var i = 0; i < drops.length; i++) {
        x.fillText(chars.charAt(Math.floor(Math.random() * chars.length)), i * fs, drops[i] * fs);
        if (drops[i] * fs > c.height && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
    }, 60);
    rain = { canvas: c, timer: timer, size: size };
  }

  window.apiaryTheme = {
    list: T,
    get: function () { try { var s = localStorage.getItem('apiary-theme'); if (byId[s]) return s; } catch (e) {} return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; },
    apply: function (id) {
      var t = byId[id] || byId.dark;
      document.documentElement.className = (t.dark ? 'dark' : 'light') + ' t-' + t.id;
      document.documentElement.style.colorScheme = t.dark ? 'dark' : 'light';
      try { localStorage.setItem('apiary-theme', t.id); } catch (e) {}
      if (document.body) { t.id === 'matrix' ? startRain() : stopRain(); }
      return t;
    }
  };
  var id = window.apiaryTheme.get(); window.apiaryTheme.apply(id);
  if (id === 'matrix') addEventListener('DOMContentLoaded', function () { startRain(); });
})();
