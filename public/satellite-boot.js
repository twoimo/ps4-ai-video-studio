(function () {
  var raw = (location.hash || "").replace(/^#/, "").replace(/\/+$/, "");
  var machine = raw === "machine" || raw.indexOf("machine/") === 0;
  var hash = machine ? "machine" : raw;
  if (hash === "template") {
    location.replace("/template");
  }
  if (hash === "create" || hash === "batch" || hash === "settings" || hash === "machine") {
    location.replace("/#" + hash);
  }
  if (hash === "watch" || raw.indexOf("watch/") === 0) {
    location.replace("/#" + (raw || "watch"));
  }
})();
