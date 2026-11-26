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
  var VERSION = /^(latest|dev|v\d+\.\d+\.\d+(-\d+)?)$/;
  if (!VERSION.test(current)) return;
  var base = parts.slice(0, at + 1).join("/") + "/";
  var rest = parts.slice(at + 2).join("/");

  // A URL of this site only: a path on this origin, never anything a page
  // or versions.json could turn into another scheme or host.
  function sameSite(path) {
    var url = new URL(path, location.origin);
    return url.origin === location.origin ? url : null;
  }

  function samePage(version) {
    return base + version + "/" + rest;
  }

  // Go to the same page in `version`, or its start page if it has none.
  function go(version) {
    if (!VERSION.test(version)) return;
    var page = sameSite(samePage(version));
    var start = sameSite(base + version + "/");
    if (!page || !start) return;
    fetch(page.href, { method: "HEAD" })
      .then(function (r) {
        location.assign(r.ok ? page.href : start.href);
      })
      .catch(function () {
        location.assign(start.href);
      });
  }

  function label(v, info) {
    if (v === "latest") return "latest (" + info.latest + ")";
    if (v === "dev") return "dev (main)";
    return v;
  }

  function switcher(info) {
    var options = [];
    if (VERSION.test(info.latest || "")) options.push("latest");
    if (info.dev) options.push("dev");
    (info.versions || []).forEach(function (v) {
      if (VERSION.test(v)) options.push(v);
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
      // The version from our own list, not the option's text.
      go(options[select.selectedIndex]);
    });
    wrap.appendChild(select);
    var right = document.querySelector("#mdbook-menu-bar .right-buttons");
    if (right) right.insertBefore(wrap, right.firstChild);
  }

  function banner(info) {
    var main = document.querySelector("main");
    if (!main || !VERSION.test(info.latest || "") || current === "latest" || current === info.latest) return;
    var box = document.createElement("div");
    box.className = "nauvi-banner";
    box.setAttribute("role", "note");
    var text =
      current === "dev"
        ? "These are the docs of the development version (main), with features not released yet. "
        : "These are the docs of nauvi " + current + ". The newest release is " + info.latest + ". ";
    box.appendChild(document.createTextNode(text));
    var a = document.createElement("a");
    var latest = sameSite(samePage("latest"));
    a.href = latest ? latest.href : base + "latest/";
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
