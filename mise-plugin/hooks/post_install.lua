local helper = require("lib.helpers")

function PLUGIN:PostInstall(ctx)
    local sdk_info = ctx.sdkInfo[PLUGIN.name]
    local install_path = sdk_info.path
    local version = sdk_info.version
    local bin_root = helper.path_join(install_path, "bin")
    local binary_path = helper.path_join(bin_root, helper.bin_name(PLUGIN.name))
    local cleanup_path = nil
    local source_root = nil

    helper.ensure_command("deno")
    helper.ensure_directory(bin_root)

    if version == "local" then
        source_root = helper.get_local_superctl_root()
    else
        local canonical_root = helper.get_canonical_superctl_root()
        local ref = helper.resolve_git_ref(canonical_root, version)
        source_root = helper.export_git_ref_to_temp_dir(canonical_root, ref)
        cleanup_path = source_root
    end

    local ok, failure = pcall(function()
        local compile_command = table.concat({
            "cd",
            helper.shell_quote(source_root),
            "&& deno compile -A --output",
            helper.shell_quote(binary_path),
            "main.ts",
        }, " ")
        helper.run(compile_command, "Could not compile superctl")

        local verify_command = helper.is_windows()
                and (helper.shell_quote(binary_path) .. " help >NUL 2>&1")
            or (helper.shell_quote(binary_path) .. " help >/dev/null 2>&1")
        helper.run(verify_command, "Compiled superctl binary failed to execute")
    end)

    if cleanup_path ~= nil then
        helper.remove_path(cleanup_path)
    end

    if not ok then
        error(failure)
    end
end
