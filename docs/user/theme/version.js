// The version switcher and the "older version" banner of the docs (#468).
//
// The docs live at <site>/docs/<version>/, where <version> is a release tag
// (v0.2.0), `latest` (a copy of the newest release) or `dev` (main). The
// list of versions is <site>/docs/versions.json, written by the pages
// workflow on every publish, so a released version never needs a rebuild
// to learn about newer ones:
//
//   { "latest": "v0.2.0", "versions": ["v0.2.0", "v0.1.0"], "dev": true }
//
// Without that file (a local build), nothing is shown.
(function () {
  "use strict";
  var parts = location.pathname.split("/");
  var at = parts.lastIndexOf("docs", parts.length - 2);
  if (at < 0) return;
  var current = parts[at + 1];
  if (!/^(latest|dev|v\d+\.\d+\.\d+(-\d+)?)$/.test(current)) return;
  var base = parts.slice(0, at + 1).join("/") + "/";
  var rest = parts.slice(at + 2).join("/");

  function samePage(version) {
    return base + version + "/" + rest + location.hash;
  }

  // Go to the same page in `version`, or its start page if it has none.
  function go(version) {
    var target = samePage(version);
    fetch(base + version + "/" + rest, { method: "HEAD" })
      .then(function (r) {
        location.href = r.ok ? target : base + version + "/";
      })
      .catch(function () {
        location.href = base + version + "/";
      });
  }

  function label(v, info) {
    if (v === "latest") return "latest (" + info.latest + ")";
    if (v === "dev") return "dev (main)";
    return v;
  }

  function switcher(info) {
    var options = [];
    if (info.latest) options.push("latest");
    if (info.dev) options.push("dev");
    (info.versions || []).forEach(function (v) {
      options.push(v);
    });
    if (options.indexOf(current) < 0) options.push(current);
    var wrap = document.createElement("label");
    wrap.className = "nauvi-version";
    wrap.title = "Docs version";
    var select = document.createElement("select");
    select.setAttribute("aria-label", "Docs version");
    options.forEach(function (v) {
      var o = document.createElement("option");
      o.value = v;
      o.textContent = label(v, info);
      if (v === current) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener("change", function () {
      go(select.value);
    });
    wrap.appendChild(select);
    var right = document.querySelector("#mdbook-menu-bar .right-buttons");
    if (right) right.insertBefore(wrap, right.firstChild);
  }

  function banner(info) {
    var main = document.querySelector("main");
    if (!main || !info.latest || current === "latest" || current === info.latest) return;
    var box = document.createElement("div");
    box.className = "nauvi-banner";
    box.setAttribute("role", "note");
    var text =
      current === "dev"
        ? "These are the docs of the development version (main), with features not released yet. "
        : "These are the docs of nauvi " + current + ". The newest release is " + info.latest + ". ";
    box.appendChild(document.createTextNode(text));
    var a = document.createElement("a");
    a.href = samePage("latest");
    a.textContent = "Read this page for the latest release";
    a.addEventListener("click", function (e) {
      e.preventDefault();
      go("latest");
    });
    box.appendChild(a);
    main.insertBefore(box, main.firstChild);
  }

  fetch(base + "versions.json", { cache: "no-cache" })
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (info) {
      if (!info) return;
      switcher(info);
      banner(info);
    })
    .catch(function () {});
})();
