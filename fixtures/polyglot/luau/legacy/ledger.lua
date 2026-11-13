local M = {}
local entries = {}

function M.record(owner, amount)
  entries[#entries + 1] = { owner = owner, amount = amount }
end

function M.count()
  return #entries
end

return M
