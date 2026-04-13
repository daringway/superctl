local M = {}

local function command_succeeded(result)
    return result == true or result == 0
end

function M.trim(value)
    return (tostring(value):gsub("^%s+", ""):gsub("%s+$", ""))
end

function M.is_windows()
    return RUNTIME.osType == "Windows"
end

function M.shell_quote(value)
    local normalized = tostring(value)
    if M.is_windows() then
        return "\"" .. normalized:gsub("\"", "\\\"") .. "\""
    end
    return "'" .. normalized:gsub("'", "'\\''") .. "'"
end

function M.run(command, description)
    local result = os.execute(command)
    if not command_succeeded(result) then
        error((description or "Command failed") .. ": " .. command)
    end
end

function M.capture(command, description)
    local handle, err = io.popen(command)
    if handle == nil then
        error((description or "Command failed") .. ": " .. tostring(err))
    end

    local output = handle:read("*a")
    local ok = handle:close()
    if ok == nil or ok == false then
        error((description or "Command failed") .. ": " .. command)
    end

    return M.trim(output)
end

function M.file_exists(path)
    local file = io.open(path, "r")
    if file then
        file:close()
        return true
    end
    return false
end

function M.path_join(...)
    local separator = M.is_windows() and "\\" or "/"
    local parts = {}
    for index = 1, select("#", ...) do
        local part = select(index, ...)
        if part ~= nil and tostring(part) ~= "" then
            table.insert(parts, tostring(part))
        end
    end
    return table.concat(parts, separator)
end

function M.ensure_command(name)
    local probe = M.is_windows() and ("where " .. name .. " >NUL 2>&1")
        or ("command -v " .. name .. " >/dev/null 2>&1")
    local result = os.execute(probe)
    if not command_succeeded(result) then
        error(name .. " is required to install superctl from source.")
    end
end

function M.ensure_directory(path)
    local command = M.is_windows() and ("mkdir " .. M.shell_quote(path) .. " 2>NUL")
        or ("mkdir -p " .. M.shell_quote(path))
    M.run(command, "Could not create directory")
end

function M.bin_name(name)
    if M.is_windows() then
        return name .. ".exe"
    end
    return name
end

function M.find_source_root(path)
    local direct_entrypoint = M.path_join(path, "main.ts")
    local direct_config = M.path_join(path, "deno.json")
    if M.file_exists(direct_entrypoint) and M.file_exists(direct_config) then
        return path
    end

    if M.is_windows() then
        error("Could not locate extracted superctl source on Windows.")
    end

    local output = M.capture(
        "find " .. M.shell_quote(path) .. " -maxdepth 2 -type f -name main.ts",
        "Could not locate extracted superctl source"
    )

    for match in output:gmatch("[^\r\n]+") do
        local source_root = match:gsub("/main%.ts$", "")
        if M.file_exists(M.path_join(source_root, "deno.json")) then
            return source_root
        end
    end

    error("Could not locate extracted superctl source in " .. path)
end

function M.get_local_superctl_root()
    local source_root = os.getenv("SUPERCTL_ROOT")
    if source_root ~= nil and M.trim(source_root) ~= "" then
        return M.trim(source_root)
    end

    return M.get_canonical_superctl_root()
end

function M.get_canonical_superctl_root()
    if M.is_windows() then
        error(
            "Could not resolve the canonical superctl checkout on Windows. Set SUPERCTL_ROOT explicitly."
        )
    end

    local plugin_root = M.capture(
        "cd " .. M.shell_quote(RUNTIME.pluginDirPath) .. " && pwd -P",
        "Could not resolve the canonical superctl plugin path"
    )
    local source_root = M.capture(
        "cd " .. M.shell_quote(M.path_join(plugin_root, "..")) .. " && pwd -P",
        "Could not resolve the canonical superctl source path"
    )
    local entrypoint = M.path_join(source_root, "main.ts")
    local config = M.path_join(source_root, "deno.json")
    if not M.file_exists(entrypoint) or not M.file_exists(config) then
        error(
            "Could not resolve the canonical superctl source checkout. Set SUPERCTL_ROOT=/absolute/path/to/repos/superctl."
        )
    end

    return source_root
end

function M.git_ref_exists(source_root, ref)
    local result = os.execute(
        "git -C "
            .. M.shell_quote(source_root)
            .. " rev-parse --verify "
            .. M.shell_quote(ref)
            .. " >/dev/null 2>&1"
    )
    return command_succeeded(result)
end

function M.resolve_git_ref(source_root, version)
    local candidates = {}
    if version == "main" then
        candidates = {
            "refs/remotes/origin/main",
            "refs/heads/main",
            "main",
        }
    else
        candidates = {
            "refs/tags/" .. version,
            version,
            "refs/tags/v" .. version,
            "v" .. version,
        }
    end

    for _, candidate in ipairs(candidates) do
        if M.git_ref_exists(source_root, candidate) then
            return candidate
        end
    end

    error("Could not resolve superctl git ref for version \"" .. version .. "\".")
end

function M.create_git_ref_archive(source_root, ref)
    M.ensure_command("git")

    local archive_path = os.tmpname()
    if archive_path:sub(-7) ~= ".tar.gz" then
        archive_path = archive_path .. ".tar.gz"
    end

    local command = table.concat({
        "git -C",
        M.shell_quote(source_root),
        "archive --format=tar.gz --output",
        M.shell_quote(archive_path),
        M.shell_quote(ref),
    }, " ")
    M.run(command, "Could not archive superctl git ref " .. ref)

    return archive_path
end

function M.get_git_ref_checksum(source_root, ref)
    if not M.git_ref_exists(source_root, ref) then
        return nil
    end

    local ok, checksum = pcall(function()
        return M.capture(
            "git -C "
                .. M.shell_quote(source_root)
                .. " rev-parse "
                .. M.shell_quote(ref)
                .. " 2>/dev/null",
            "Could not read the superctl git revision"
        )
    end)
    if ok and checksum ~= "" then
        return checksum
    end

    return nil
end

function M.list_git_tags(source_root)
    local ok, output = pcall(function()
        return M.capture(
            "git -C " .. M.shell_quote(source_root) .. " tag --list",
            "Could not list superctl git tags"
        )
    end)
    if not ok or output == "" then
        return {}
    end

    local tags = {}
    for tag in output:gmatch("[^\r\n]+") do
        table.insert(tags, M.trim(tag))
    end
    return tags
end

function M.create_local_archive(source_root)
    if M.is_windows() then
        error("superctl@local is currently only supported on Unix-like systems.")
    end

    M.ensure_command("tar")

    local archive_path = os.tmpname()
    if archive_path:sub(-7) ~= ".tar.gz" then
        archive_path = archive_path .. ".tar.gz"
    end

    local command = table.concat({
        "tar -czf",
        M.shell_quote(archive_path),
        "--exclude=.git",
        "--exclude=node_modules",
        "--exclude=dist",
        "--exclude=coverage",
        "-C",
        M.shell_quote(source_root),
        ".",
    }, " ")
    M.run(command, "Could not archive the local superctl source tree")

    return archive_path
end

function M.create_temp_dir()
    if M.is_windows() then
        error("Temporary directory helpers are currently only supported on Unix-like systems.")
    end

    return M.capture("mktemp -d", "Could not create a temporary directory")
end

function M.remove_path(path)
    local command = M.is_windows() and ("rmdir /s /q " .. M.shell_quote(path))
        or ("rm -rf " .. M.shell_quote(path))
    M.run(command, "Could not remove temporary path")
end

function M.export_git_ref_to_temp_dir(source_root, ref)
    if M.is_windows() then
        error("Git ref export is currently only supported on Unix-like systems.")
    end

    M.ensure_command("git")
    M.ensure_command("tar")

    local temp_dir = M.create_temp_dir()
    local command = table.concat({
        "git -C",
        M.shell_quote(source_root),
        "archive",
        M.shell_quote(ref),
        "| tar -xzf - -C",
        M.shell_quote(temp_dir),
    }, " ")
    M.run(command, "Could not export superctl git ref " .. ref)

    return temp_dir
end

function M.get_local_checkout_checksum()
    local source_root = os.getenv("SUPERCTL_ROOT")
    if source_root == nil or M.trim(source_root) == "" then
        return nil
    end

    local entrypoint = M.path_join(M.trim(source_root), "main.ts")
    if not M.file_exists(entrypoint) or M.is_windows() then
        return nil
    end

    local ok, checksum = pcall(function()
        return M.capture(
            "git -C " .. M.shell_quote(M.trim(source_root)) .. " rev-parse HEAD 2>/dev/null",
            "Could not read the local superctl checkout revision"
        )
    end)
    if ok and checksum ~= "" then
        return checksum
    end

    return nil
end

return M
