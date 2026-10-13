-- Mainland-China allowlist for the formal vhost (2026-10-13). The table is built daily on stardust
-- (APNIC CN + Loyalsoldier/geoip cn, see build_cn_allow.py) and installed here atomically; every worker
-- re-reads it when the header line changes, so updates need no reload. Fails open: without a valid
-- table nobody is denied. Loopback and private peers are never denied.
local M = {}

local byte, fmt, floor, tonumber = string.byte, string.format, math.floor, tonumber
local path, header, problem
local v4s, v4e, v6s, v6e -- sorted range starts/ends; nil = no table (allow all)

-- logs a problem once per distinct cause, not on every check
local function report(what, key)
    if problem == key then return end
    problem = key
    ngx.log(ngx.ERR, "ark_geo: ", what, " (", path, ")", v4s and "; keeping the current table" or "; allowing all")
end

local function load()
    local f, err = io.open(path, "r")
    if not f then return report("cannot open: " .. tostring(err), "open") end
    local first = f:read("*l")
    if first == header or (first and first == problem) then f:close() return end
    if not first or not first:find("^# ark%-geo%-cn v1 ") then
        f:close()
        return report("bad header", first or "empty")
    end
    local a4s, a4e, a6s, a6e, n4, n6 = {}, {}, {}, {}, 0, 0
    for line in f:lines() do
        local fam, s, e = line:match("^([46]) (%x+) (%x+)$")
        if fam == "4" then
            n4 = n4 + 1; a4s[n4] = tonumber(s); a4e[n4] = tonumber(e)
        elseif fam == "6" then
            n6 = n6 + 1; a6s[n6] = s; a6e[n6] = e
        else
            f:close()
            return report("bad line " .. (n4 + n6 + 2), first)
        end
    end
    f:close()
    if n4 < 1000 or n6 < 500 then return report("table too small (" .. n4 .. "/" .. n6 .. ")", first) end
    v4s, v4e, v6s, v6e, header, problem = a4s, a4e, a6s, a6e, first, nil
    ngx.log(ngx.WARN, "ark_geo: loaded ", n4, " IPv4 and ", n6, " IPv6 ranges")
end

-- index of the last start <= key, then whether key is inside that range
local function within(s, e, key)
    local lo, hi = 1, #s
    while lo <= hi do
        local mid = floor((lo + hi) / 2)
        if s[mid] <= key then lo = mid + 1 else hi = mid - 1 end
    end
    return hi >= 1 and key <= e[hi]
end

local function v4deny(a, b, c, d)
    if a == 127 or a == 10 or (a == 172 and b >= 16 and b <= 31) or (a == 192 and b == 168)
        or (a == 100 and b >= 64 and b <= 127) then
        return ""
    end
    return within(v4s, v4e, ((a * 256 + b) * 256 + c) * 256 + d) and "" or "1"
end

--- "1" when the peer (ngx.var.binary_remote_addr) should be refused, "" otherwise.
function M.deny(bin)
    if not v4s or not bin then return "" end
    local n = #bin
    if n == 4 then
        return v4deny(byte(bin, 1, 4))
    elseif n == 16 then
        local b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12 = byte(bin, 1, 12)
        if b1 == 0 and b2 == 0 and b3 == 0 and b4 == 0 and b5 == 0 and b6 == 0 and b7 == 0 and b8 == 0
            and b9 == 0 and b10 == 0 then
            if b11 == 255 and b12 == 255 then return v4deny(byte(bin, 13, 16)) end -- IPv4-mapped
            return "" -- ::1 and other reserved low space
        end
        if b1 == 0xfc or b1 == 0xfd or (b1 == 0xfe and b2 >= 0x80 and b2 <= 0xbf) then return "" end -- ULA, link-local
        return within(v6s, v6e, fmt("%02x%02x%02x%02x%02x%02x%02x%02x", b1, b2, b3, b4, b5, b6, b7, b8)) and "" or "1"
    end
    return ""
end

--- Load now and re-check every `interval` seconds (call from init_worker_by_lua).
function M.start(file, interval)
    path = file
    local ok, err = pcall(load)
    if not ok then ngx.log(ngx.ERR, "ark_geo: ", err) end
    local _, terr = ngx.timer.every(interval or 60, function(premature)
        if premature then return end
        local lok, lerr = pcall(load)
        if not lok then ngx.log(ngx.ERR, "ark_geo: ", lerr) end
    end)
    if terr then ngx.log(ngx.ERR, "ark_geo: timer: ", terr) end
end

function M.status()
    return v4s and #v4s or 0, v6s and #v6s or 0, header
end

return M
