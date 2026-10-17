-- Material profile preload, rendered by tools/prepare-material-lb.py next to access.lua and header.lua. The vhost's
-- single http-level init_by_lua_block runs it through pcall(dofile, ...) in the nginx master, at start and at every
-- reload (OpenResty skips init_by_lua for `nginx -t` and the `-s` signaller); the forked workers inherit the tables.
-- Without it each worker reads, decodes and validates routes.json/header-data.json on its first public request:
-- after a reload all new workers do so at once and none of them answers its other connections meanwhile.
-- The blocks are cut verbatim from this profile's access.lua and header.lua (same package.loaded keys, file paths,
-- validation and cached `false` for an unreadable or invalid inventory); those keep them as the lazy fallback.
do
__MATERIAL_LB_ACCESS_LOADER__if db == false then ngx.log(ngx.ERR, "material preload: invalid route inventory ", key) end
end
do
__MATERIAL_LB_HEADER_LOADER__if data == false then ngx.log(ngx.ERR, "material preload: invalid header inventory ", key) end
end
