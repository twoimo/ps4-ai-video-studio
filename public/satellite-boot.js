(function () {
  var hash = (location.hash || "").replace(/^#/, "");
  if (hash === "create" || hash === "batch" || hash === "settings") {
    location.replace("/#" + hash);
  }
})();
