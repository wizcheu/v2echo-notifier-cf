CREATE TABLE http_proxy (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  address TEXT NOT NULL DEFAULT '',
  authenticated INTEGER NOT NULL DEFAULT 0 CHECK(authenticated IN (0,1)),
  payload TEXT NOT NULL DEFAULT ''
);
INSERT INTO http_proxy(id) VALUES(1);
