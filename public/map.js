/* =========================================================
   轻量地图组件 · 无第三方依赖
   底图：OpenStreetMap
   ========================================================= */
(function () {
  "use strict";

  var TILE_SIZE = 256;
  var MIN_ZOOM = 3;
  var MAX_ZOOM = 19;
  var EARTH_RADIUS_METERS = 6378137;
  var DEFAULT_CENTER = { lat: 34.6, lng: 104.2 };
  var DEFAULT_ZOOM = 4;

  var TILE_PROVIDERS = {
    osmde: {
      key: "osmde",
      url: "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
      credit: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>',
      title: "© OpenStreetMap contributors · Tiles by FOSSGIS"
    },
    esri: {
      key: "esri",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      credit: '<a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">© Esri</a>' +
        ' · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OSM</a>',
      title: "Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors"
    }
  };

  function preferredProvider() {
    // OpenStreetMap.de is reachable in mainland China and keeps WGS84 / Web Mercator.
    // Esri remains available as an automatic fallback.
    return TILE_PROVIDERS.osmde;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clampLat(lat) {
    return clamp(Number(lat) || 0, -85.05112878, 85.05112878);
  }

  function wrapLng(lng) {
    var value = Number(lng) || 0;
    value = ((value + 180) % 360 + 360) % 360 - 180;
    return value;
  }

  function project(lat, lng, zoom) {
    var worldSize = TILE_SIZE * Math.pow(2, zoom);
    var sinLat = Math.sin(clampLat(lat) * Math.PI / 180);
    return {
      x: (wrapLng(lng) + 180) / 360 * worldSize,
      y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize,
      worldSize: worldSize
    };
  }

  function unproject(x, y, zoom) {
    var worldSize = TILE_SIZE * Math.pow(2, zoom);
    var lng = x / worldSize * 360 - 180;
    var n = Math.PI - 2 * Math.PI * y / worldSize;
    var lat = 180 / Math.PI * Math.atan(Math.sinh(n));
    return {
      lat: clampLat(lat),
      lng: wrapLng(lng)
    };
  }

  function metersPerPixel(lat, zoom) {
    return Math.cos(clampLat(lat) * Math.PI / 180) * 2 * Math.PI * EARTH_RADIUS_METERS /
      (TILE_SIZE * Math.pow(2, zoom));
  }

  function LocationMap(element, options) {
    if (!element) {
      throw new Error("LocationMap requires a container element.");
    }

    this.el = element;
    this.options = options || {};
    this.provider = this.options.provider || preferredProvider();
    this.providerKey = this.provider.key;
    this.fallbackTried = this.providerKey !== "osmde";
    this.zoom = clamp(this.options.zoom || DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM);
    this.minZoom = this.options.minZoom || MIN_ZOOM;
    this.maxZoom = this.options.maxZoom || MAX_ZOOM;
    this.center = {
      lat: clampLat(this.options.center && this.options.center.lat != null ? this.options.center.lat : DEFAULT_CENTER.lat),
      lng: wrapLng(this.options.center && this.options.center.lng != null ? this.options.center.lng : DEFAULT_CENTER.lng)
    };
    this.marker = null;
    this.tiles = new Map();
    this.tileErrors = 0;
    this.tileLoads = 0;
    this.dragging = false;
    this.mounted = false;
    this.rafId = 0;
    this.dragState = null;
    this.resizeObserver = null;
    this.emptyTitle = "等待定位";
    this.emptySub = "获取位置后将在此显示";

    this.build();
    this.bind();
    this.observeSize();

    var self = this;
    window.requestAnimationFrame(function () {
      self.mounted = true;
      self.render();
    });
  }

  LocationMap.prototype.build = function () {
    this.el.classList.add("loc-map");
    this.el.tabIndex = 0;
    this.el.setAttribute("role", "application");
    this.el.setAttribute("aria-roledescription", "地图");
    this.el.innerHTML = [
      '<div class="map-tiles" aria-hidden="true"></div>',
      '<div class="map-vignette" aria-hidden="true"></div>',
      '<div class="map-accuracy" hidden aria-hidden="true"></div>',
      '<div class="map-marker" hidden aria-hidden="true">',
      '  <span class="map-marker-pulse"></span>',
      '  <span class="map-marker-dot"></span>',
      '  <span class="map-marker-label">当前位置</span>',
      "</div>",
      '<div class="map-empty">',
      '  <span class="map-empty-icon">',
      '    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-5.9 7-12a7 7 0 1 0-14 0c0 6.1 7 12 7 12Z"></path><circle cx="12" cy="9" r="2.5"></circle></svg>',
      "  </span>",
      '  <strong data-empty-title>等待定位</strong>',
      '  <span data-empty-sub>获取位置后将在此显示</span>',
      "</div>",
      '<div class="map-ui map-zoom" aria-label="地图缩放">',
      '  <button type="button" data-map-action="zoom-in" aria-label="放大地图">+</button>',
      '  <button type="button" data-map-action="zoom-out" aria-label="缩小地图">−</button>',
      "</div>",
      '<button type="button" class="map-ui map-locate" data-map-action="recenter" aria-label="回到当前位置" hidden>',
      '  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path><circle cx="12" cy="12" r="1.5"></circle></svg>',
      "</button>",
      '<div class="map-credit" data-map-credit></div>',
      '<div class="map-failure">底图暂不可用，定位坐标仍会记录</div>'
    ].join("");

    this.tileLayer = this.el.querySelector(".map-tiles");
    this.emptyEl = this.el.querySelector(".map-empty");
    this.emptyTitleEl = this.el.querySelector("[data-empty-title]");
    this.emptySubEl = this.el.querySelector("[data-empty-sub]");
    this.markerEl = this.el.querySelector(".map-marker");
    this.markerLabelEl = this.el.querySelector(".map-marker-label");
    this.accuracyEl = this.el.querySelector(".map-accuracy");
    this.recenterBtn = this.el.querySelector('[data-map-action="recenter"]');
    this.zoomInBtn = this.el.querySelector('[data-map-action="zoom-in"]');
    this.zoomOutBtn = this.el.querySelector('[data-map-action="zoom-out"]');
    this.creditEl = this.el.querySelector("[data-map-credit]");
    this.setCredit();
  };

  LocationMap.prototype.setCredit = function () {
    if (!this.creditEl) {
      return;
    }
    this.creditEl.innerHTML = this.provider.credit;
    this.creditEl.title = this.provider.title;
  };

  LocationMap.prototype.switchProvider = function (providerKey) {
    if (this.providerKey === providerKey) {
      return;
    }
    var provider = TILE_PROVIDERS[providerKey];
    if (!provider) {
      return;
    }

    this.provider = provider;
    this.providerKey = providerKey;
    this.tileErrors = 0;
    this.tiles.forEach(function (image) {
      image.remove();
    });
    this.tiles.clear();
    this.tileLayer.innerHTML = "";
    this.el.classList.remove("has-tile-error");
    this.setCredit();
    this.render();
  };

  LocationMap.prototype.bind = function () {
    var self = this;

    this.el.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 && event.pointerType === "mouse") {
        return;
      }
      if (event.target.closest(".map-ui, .map-credit")) {
        return;
      }

      var centerPixel = project(self.center.lat, self.center.lng, self.zoom);
      self.dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        centerX: centerPixel.x,
        centerY: centerPixel.y,
        moved: false
      };

      try {
        self.el.setPointerCapture(event.pointerId);
      } catch (error) {
        /* pointer capture is a progressive enhancement */
      }
    });

    this.el.addEventListener("pointermove", function (event) {
      if (!self.dragState || self.dragState.pointerId !== event.pointerId) {
        return;
      }

      var dx = event.clientX - self.dragState.startX;
      var dy = event.clientY - self.dragState.startY;

      if (!self.dragState.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        self.dragState.moved = true;
        self.dragging = true;
        self.el.classList.add("is-dragging");
      }

      if (!self.dragState.moved) {
        return;
      }

      var point = unproject(
        self.dragState.centerX - dx,
        self.dragState.centerY - dy,
        self.zoom
      );
      self.center = point;
      self.scheduleRender();
    });

    function endDrag(event) {
      if (!self.dragState || self.dragState.pointerId !== event.pointerId) {
        return;
      }
      self.dragState = null;
      self.dragging = false;
      self.el.classList.remove("is-dragging");
      try {
        if (self.el.hasPointerCapture(event.pointerId)) {
          self.el.releasePointerCapture(event.pointerId);
        }
      } catch (error) {
        /* noop */
      }
    }

    this.el.addEventListener("pointerup", endDrag);
    this.el.addEventListener("pointercancel", endDrag);

    this.el.addEventListener("wheel", function (event) {
      if (event.target.closest(".map-ui, .map-credit")) {
        return;
      }
      event.preventDefault();
      self.setZoom(self.zoom + (event.deltaY > 0 ? -1 : 1));
    }, { passive: false });

    this.el.addEventListener("dblclick", function (event) {
      if (event.target.closest(".map-ui, .map-credit")) {
        return;
      }
      self.setZoom(self.zoom + 1);
    });

    this.el.addEventListener("keydown", function (event) {
      var step = 90;
      var pixel = project(self.center.lat, self.center.lng, self.zoom);
      var handled = true;

      switch (event.key) {
        case "ArrowLeft":
          self.center = unproject(pixel.x - step, pixel.y, self.zoom);
          break;
        case "ArrowRight":
          self.center = unproject(pixel.x + step, pixel.y, self.zoom);
          break;
        case "ArrowUp":
          self.center = unproject(pixel.x, pixel.y - step, self.zoom);
          break;
        case "ArrowDown":
          self.center = unproject(pixel.x, pixel.y + step, self.zoom);
          break;
        case "+":
        case "=":
          self.setZoom(self.zoom + 1);
          break;
        case "-":
        case "_":
          self.setZoom(self.zoom - 1);
          break;
        case "Home":
          if (self.marker) {
            self.center = { lat: self.marker.lat, lng: self.marker.lng };
            self.zoom = Math.max(self.zoom, 15);
            self.render();
          }
          break;
        default:
          handled = false;
      }

      if (handled) {
        event.preventDefault();
        self.scheduleRender();
      }
    });

    this.zoomInBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      self.setZoom(self.zoom + 1);
    });

    this.zoomOutBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      self.setZoom(self.zoom - 1);
    });

    this.recenterBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      if (!self.marker) {
        return;
      }
      self.center = { lat: self.marker.lat, lng: self.marker.lng };
      self.zoom = Math.max(self.zoom, 15);
      self.render();
    });
  };

  LocationMap.prototype.observeSize = function () {
    var self = this;
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(function () {
        self.scheduleRender();
      });
      this.resizeObserver.observe(this.el);
    } else {
      window.addEventListener("resize", function () {
        self.scheduleRender();
      });
    }
  };

  LocationMap.prototype.scheduleRender = function () {
    var self = this;
    if (this.rafId) {
      return;
    }
    this.rafId = window.requestAnimationFrame(function () {
      self.rafId = 0;
      self.render();
    });
  };

  LocationMap.prototype.render = function () {
    if (!this.mounted) {
      return;
    }

    var rect = this.el.getBoundingClientRect();
    var width = Math.ceil(rect.width);
    var height = Math.ceil(rect.height);

    if (width < 2 || height < 2) {
      return;
    }

    var zoom = this.zoom;
    var tileCount = Math.pow(2, zoom);
    var centerPixel = project(this.center.lat, this.center.lng, zoom);
    var originX = centerPixel.x - width / 2;
    var originY = centerPixel.y - height / 2;

    var minTileX = Math.floor(originX / TILE_SIZE);
    var maxTileX = Math.floor((originX + width) / TILE_SIZE);
    var minTileY = Math.floor(originY / TILE_SIZE);
    var maxTileY = Math.floor((originY + height) / TILE_SIZE);

    var wanted = new Set();
    var fragment = document.createDocumentFragment();
    var added = false;

    for (var tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      for (var tileY = minTileY; tileY <= maxTileY; tileY += 1) {
        if (tileY < 0 || tileY >= tileCount) {
          continue;
        }

        var wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
        var key = zoom + "/" + tileX + "/" + tileY;
        wanted.add(key);

        var image = this.tiles.get(key);
        if (!image) {
          image = this.createTile(zoom, wrappedX, tileY);
          this.tiles.set(key, image);
          fragment.appendChild(image);
          added = true;
        }

        var left = tileX * TILE_SIZE - originX;
        var top = tileY * TILE_SIZE - originY;
        var transform = "translate3d(" + left + "px, " + top + "px, 0)";

        if (image.style.transform !== transform) {
          image.style.transform = transform;
        }
        image.hidden = false;
      }
    }

    if (added) {
      this.tileLayer.appendChild(fragment);
    }

    this.tiles.forEach(function (image, key) {
      if (!wanted.has(key)) {
        image.hidden = true;
      }
    });

    this.pruneTiles(wanted);
    this.updateMarker(originX, originY, zoom);

    this.zoomInBtn.disabled = zoom >= this.maxZoom;
    this.zoomOutBtn.disabled = zoom <= this.minZoom;
  };

  LocationMap.prototype.createTile = function (zoom, x, y) {
    var self = this;
    var providerKey = this.providerKey;
    var image = document.createElement("img");
    image.className = "map-tile";
    image.alt = "";
    image.draggable = false;
    image.decoding = "async";
    image.dataset.provider = providerKey;
    image.src = this.provider.url
      .replace("{z}", String(zoom))
      .replace("{x}", String(x))
      .replace("{y}", String(y));

    image.addEventListener("load", function () {
      if (providerKey !== self.providerKey) {
        return;
      }
      image.classList.add("is-loaded");
      self.tileLoads += 1;
    });

    image.addEventListener("error", function () {
      if (providerKey !== self.providerKey || image.hidden) {
        return;
      }
      image.classList.add("is-broken");
      self.tileErrors += 1;
      if (self.tileErrors < 4) {
        return;
      }
      if (self.providerKey === "osmde" && !self.fallbackTried) {
        self.fallbackTried = true;
        self.switchProvider("esri");
      } else {
        self.el.classList.add("has-tile-error");
      }
    });

    return image;
  };

  LocationMap.prototype.pruneTiles = function (wanted) {
    if (this.tiles.size <= 140) {
      return;
    }

    var removable = [];
    this.tiles.forEach(function (image, key) {
      if (!wanted.has(key)) {
        removable.push(key);
      }
    });

    for (var index = 0; index < removable.length && this.tiles.size > 110; index += 1) {
      var key = removable[index];
      var image = this.tiles.get(key);
      if (image) {
        image.remove();
      }
      this.tiles.delete(key);
    }
  };

  LocationMap.prototype.updateMarker = function (originX, originY, zoom) {
    if (!this.marker) {
      this.markerEl.hidden = true;
      this.accuracyEl.hidden = true;
      this.recenterBtn.hidden = true;
      return;
    }

    var pixel = project(this.marker.lat, this.marker.lng, zoom);
    var x = pixel.x - originX;
    var y = pixel.y - originY;

    this.markerEl.hidden = false;
    this.markerEl.style.transform = "translate3d(" + x + "px, " + y + "px, 0)";
    this.recenterBtn.hidden = false;

    var accuracy = Number(this.marker.accuracy);
    if (isFinite(accuracy) && accuracy > 0) {
      var radiusPx = accuracy / metersPerPixel(this.marker.lat, zoom);
      radiusPx = clamp(radiusPx, 11, 300);
      this.accuracyEl.hidden = false;
      this.accuracyEl.style.width = (radiusPx * 2) + "px";
      this.accuracyEl.style.height = (radiusPx * 2) + "px";
      this.accuracyEl.style.transform =
        "translate3d(" + (x - radiusPx) + "px, " + (y - radiusPx) + "px, 0)";
    } else {
      this.accuracyEl.hidden = true;
    }
  };

  LocationMap.prototype.setZoom = function (nextZoom) {
    var zoom = clamp(Math.round(nextZoom), this.minZoom, this.maxZoom);
    if (zoom === this.zoom) {
      return;
    }
    this.zoom = zoom;
    this.render();
  };

  LocationMap.prototype.setCenter = function (lat, lng, zoom) {
    this.center = { lat: clampLat(lat), lng: wrapLng(lng) };
    if (typeof zoom === "number") {
      this.zoom = clamp(Math.round(zoom), this.minZoom, this.maxZoom);
    }
    this.render();
  };

  LocationMap.prototype.setLocation = function (lat, lng, options) {
    var settings = options || {};
    var safeLat = clampLat(lat);
    var safeLng = wrapLng(lng);

    this.marker = {
      lat: safeLat,
      lng: safeLng,
      accuracy: settings.accuracy != null ? Number(settings.accuracy) : null
    };

    this.el.classList.remove("is-locating");
    this.emptyEl.classList.add("is-hidden");
    this.markerLabelEl.textContent = settings.label || "当前位置";

    if (settings.center !== false) {
      this.center = { lat: safeLat, lng: safeLng };
    }

    if (settings.zoom != null) {
      this.zoom = clamp(Math.round(settings.zoom), this.minZoom, this.maxZoom);
    } else if (settings.center !== false) {
      this.zoom = Math.max(this.zoom, 15);
    }

    this.render();
  };

  LocationMap.prototype.setLoading = function (title, subtitle) {
    this.el.classList.add("is-locating");
    this.emptyTitleEl.textContent = title || "正在定位";
    this.emptySubEl.textContent = subtitle || "请允许浏览器访问当前位置";
    this.emptyEl.classList.remove("is-hidden");
  };

  LocationMap.prototype.showEmpty = function (title, subtitle) {
    this.el.classList.remove("is-locating");
    this.emptyTitleEl.textContent = title || "等待定位";
    this.emptySubEl.textContent = subtitle || "获取位置后将在此显示";
    this.emptyEl.classList.remove("is-hidden");
  };

  LocationMap.prototype.clearLocation = function () {
    this.marker = null;
    this.markerEl.hidden = true;
    this.accuracyEl.hidden = true;
    this.recenterBtn.hidden = true;
    this.render();
  };

  LocationMap.prototype.resize = function () {
    this.render();
  };

  LocationMap.prototype.destroy = function () {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
    }
    this.tiles.clear();
    this.el.innerHTML = "";
  };

  window.LocationMap = LocationMap;
})();
