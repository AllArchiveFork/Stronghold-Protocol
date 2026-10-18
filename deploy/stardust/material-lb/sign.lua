-- Batch signer (fork 2026-10-17), rendered by tools/prepare-material-lb.py --signed-ttl next to access.lua and loaded
-- by sign-location.conf (content phase of POST /material-sign). public/sw.js sends the cache misses of one burst as
-- {"paths": [alias, ...]} and gets {"urls": {alias: [signed CDN URL, seconds it stays valid]}}, then downloads each
-- file from the CDN itself: one request here per batch instead of one signed 302 per file. An alias left out of
-- "urls" (unknown, OpenI-only, signer cooling down, over the time budget) is fetched by its plain path as before.
-- The block below is cut verbatim from this profile's access.lua (same package.loaded key, file path, validation and
-- cached `false`), so the inventory preload.lua loads in the master serves this file too.
__MATERIAL_LB_ACCESS_LOADER__if type(db) ~= "table" then return ngx.exit(500) end

local MAX_BODY = 16384
local MAX_PATHS = 64          -- public/sw.js SIGN_BATCH_MAX
local THREADS = 8             -- signing requests to ModelScope at once for one batch (cached URLs cost nothing)
local BUDGET = 2.5            -- seconds; an alias not signed by then is left out

if ngx.req.get_method() ~= "POST" then
    ngx.header["Allow"] = "POST"
    return ngx.exit(405)
end
local signer_file = __MATERIAL_LB_SIGNER__
local signer = package.loaded[signer_file]
if signer == nil then
    local ok, module = pcall(dofile, signer_file)
    signer = ok and type(module) == "table" and module or false
    package.loaded[signer_file] = signer
end
if not signer or type(signer.valid_for) ~= "function" then return ngx.exit(404) end

local length = tonumber(ngx.var.http_content_length or "")
if not length or length < 2 or length > MAX_BODY then return ngx.exit(400) end
ngx.req.read_body()
local body = ngx.req.get_body_data()
if not body or #body > MAX_BODY then return ngx.exit(400) end
local request = cjson.decode(body)
if type(request) ~= "table" or type(request.paths) ~= "table" then return ngx.exit(400) end
local list, seen = {}, {}
local count = 0
for _ in pairs(request.paths) do count = count + 1 end
if count == 0 or count > MAX_PATHS or count ~= #request.paths then return ngx.exit(400) end
for _, path in ipairs(request.paths) do
    if type(path) ~= "string" or #path > 2049 then return ngx.exit(400) end
    if not seen[path] then
        seen[path] = true
        list[#list + 1] = path
    end
end

local urls = {}
local deadline = ngx.now() + BUDGET
local index = 0
local function work()
    while true do
        index = index + 1
        local path = list[index]
        if not path or ngx.now() >= deadline then return end
        local target = rawget(db.paths, path)
        if type(target) == "string" and not openi_only[path] and model_target_allowed(target) then
            local ok, url, ts = pcall(signer.location, target)
            if ok and url then
                local seconds = signer.valid_for(ts)
                if seconds > 0 then urls[path] = { url, seconds } end
            end
        end
    end
end
local threads = {}
for i = 1, math.min(THREADS, #list) do threads[i] = ngx.thread.spawn(work) end
for i = 1, #threads do ngx.thread.wait(threads[i]) end

ngx.header["Content-Type"] = "application/json"
ngx.header["Cache-Control"] = "no-store"
ngx.header["X-Content-Type-Options"] = "nosniff"
-- cjson encodes an empty table as {}: "urls" stays an object
ngx.print(cjson.encode({ urls = urls }))
