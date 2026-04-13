local helper = require("lib.helpers")

function PLUGIN:PreInstall(ctx)
    local version = ctx.version

    if version == "local" then
        local source_root = helper.get_local_superctl_root()
        local entrypoint = helper.path_join(source_root, "main.ts")
        local config = helper.path_join(source_root, "deno.json")
        if not helper.file_exists(entrypoint) or not helper.file_exists(config) then
            error(
                "superctl@local requires SUPERCTL_ROOT="
                    .. source_root
                    .. " with both \"main.ts\" and \"deno.json\"."
            )
        end

        return {
            version = version,
            note = "Building superctl from SUPERCTL_ROOT",
        }
    end

    return {
        version = version,
        note = "Building superctl " .. version .. " from a canonical git ref",
    }
end
