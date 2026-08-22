(function () {
  var hash = (location.hash || "").replace(/^#/, "");
  if (hash === "create" || hash === "batch" || hash === "settings" || hash === "machine") {
    location.replace("/#" + hash);
  }
})();
