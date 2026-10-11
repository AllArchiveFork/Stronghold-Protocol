-- ModelScope signed-redirect cache: rendered by tools/prepare-material-lb.py --signed-ttl and loaded once per worker
-- by access.lua for public /assets/ and /media/ GETs. Needs mssign-http.conf and mssign-server.conf (MATERIAL-SOURCES.md).
-- The public resolve URL (modelscope.cn: HTTP/1.1 only, ~0.1-0.3 s, an uncacheable 302 carrying a fresh CDN
-- auth_key every time) is resolved here once per object and signature window, so a browser follows one redirect
-- straight to the HTTP/2 CDN instead of queueing every icon on six HTTP/1.1 connections to modelscope.cn.
-- No rate limit: one signing request per object and window (singleflight). An upstream error cooldown, a lock
-- timeout, an unexpected answer or a missing dictionary keeps the previous behavior:
-- the caller redirects to the public resolve URL itself. Signed URLs live in shared memory only, never in logs.
local resty_lock = require "resty.lock"

local M = {}
local ORIGIN = "https://modelscope.cn"
local REVISION = "__MATERIAL_LB_SIGNED_REVISION__"
local NAMESPACE, REPOSITORY = "__MATERIAL_LB_SIGNED_NAMESPACE__", "__MATERIAL_LB_SIGNED_REPOSITORY__"
local TTL = __MATERIAL_LB_SIGNED_TTL__ -- signature validity after its timestamp: a measured lower bound, not the provider's setting
local SAFETY = 120              -- never hand out a URL with less validity left than this
local REFRESH = 300             -- re-sign when less than this is left; until SAFETY the old URL is still served
local BROWSER_MAX = 300         -- browser max-age for the signed redirect, always ending >= 60 s before expiry
local allowed = { filename = true, namespace = true, repository = true, revision = true, tag = true, auth_key = true }
local dict = ngx.shared.ark_ms_lock and ngx.shared.ark_ms_signed

-- The only accepted destination: an HTTPS ModelScope LFS CDN object of this repository revision with a type-A
-- auth_key whose timestamp is now (it starts the provider's validity window). Returns that timestamp.
local function signed(location, now)
    if type(location) ~= "string" or #location > 2048 or location:find("[^%w%-%._~:/%?&=%%]") then return nil end
    local host, query = location:match("^https://([%w%-%.]+)/prod/lfs%-objects/%x%x/%x%x/%x+%?(.+)$")
    if not host or not host:match("^cdn%-lfs[%w%-]*%.modelscope%.cn$") then return nil end
    local seen = {}
    for pair in query:gmatch("[^&]+") do
        local key, value = pair:match("^([%w_]+)=([^=]+)$")
        if not key or not allowed[key] or seen[key] then return nil end
        seen[key] = value
    end
    if query:find("&&", 1, true) or query:sub(1, 1) == "&" or query:sub(-1) == "&" then return nil end
    if seen.namespace ~= NAMESPACE or seen.repository ~= REPOSITORY or seen.revision ~= REVISION
        or not seen.filename or not seen.auth_key then return nil end
    local ts = tonumber(seen.auth_key:match("^(%d+)%-%w+%-%d+%-%x+$"))
    if not ts or ts < now - 120 or ts > now + 120 then return nil end
    return ts
end

local function fetch(target)
    local res = ngx.location.capture("/_ark_ms_resolve", {
        method = ngx.HTTP_HEAD, vars = { ark_ms_uri = target:sub(#ORIGIN + 1) } })
    local status = res and res.status or 0
    if status == 302 then
        local ts = signed(res.header["Location"], ngx.time())
        if ts then return res.header["Location"], ts end
        dict:set("bad:" .. target, true, 600)
    elseif status == 403 or status == 429 then
        dict:set("cool", true, 60)
    elseif status == 200 and tostring(res.header["Content-Type"] or ""):find("html", 1, true) then
        dict:set("cool", true, 60)       -- a WAF/challenge page, not an object
    elseif status == 0 or status >= 500 then
        dict:set("cool", true, 10)
    else
        dict:set("bad:" .. target, true, 600)   -- 200 non-LFS object, 404: the browser keeps the public URL
    end
    return nil
end

local function cached(target)
    local value = dict:get(target)
    if not value then return nil end
    local ts, url = value:match("^(%d+)|(.+)$")
    return url, tonumber(ts)
end

--- Signed CDN URL and browser max-age for a validated public resolve `target`, or nil (redirect to `target`).
function M.location(target)
    if not dict or type(target) ~= "string" or target:sub(1, #ORIGIN + 1) ~= ORIGIN .. "/" then return nil end
    local now = ngx.time()
    local url, ts = cached(target)
    local usable = url and now < ts + TTL - SAFETY
    if usable and now < ts + TTL - REFRESH then return url, ts end
    if dict:get("cool") or dict:get("bad:" .. target) then
        if usable then return url, ts end
        return nil
    end
    -- One signing request per object across all workers; a usable old URL never waits for it.
    local lock = resty_lock:new("ark_ms_lock", { exptime = 5, timeout = usable and 0 or 1.5 })
    if not lock or not lock:lock(target) then
        if usable then return url, ts end
        return nil
    end
    local fresh_url, fresh_ts = cached(target)
    if fresh_url and ngx.time() < fresh_ts + TTL - REFRESH then
        lock:unlock()
        return fresh_url, fresh_ts
    end
    local ok, location, sts = pcall(fetch, target)
    if ok and location then
        dict:set(target, sts .. "|" .. location, sts + TTL - SAFETY - ngx.time())
    end
    lock:unlock()
    if ok and location then return location, sts end
    if usable then return url, ts end
    return nil
end

--- Browser cache lifetime for a URL signed at `ts`: the cached redirect ends at least 60 s before the signature.
function M.max_age(ts)
    return math.max(0, math.min(BROWSER_MAX, ts + TTL - 60 - ngx.time()))
end

return M
