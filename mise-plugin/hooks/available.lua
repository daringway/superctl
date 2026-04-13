local helper = require("lib.helpers")

function PLUGIN:Available(_ctx)
    local result = {}
    local source_root = nil
    local ok, resolved_root = pcall(function()
        return helper.get_canonical_superctl_root()
    end)
    if ok then
        source_root = resolved_root
    end

    local main_checksum = nil
    local tags = {}
    if source_root ~= nil then
        main_checksum = helper.get_git_ref_checksum(source_root, "refs/remotes/origin/main")
            or helper.get_git_ref_checksum(source_root, "refs/heads/main")
            or helper.get_git_ref_checksum(source_root, "main")
        tags = helper.list_git_tags(source_root)
    end

    table.insert(result, {
        version = "main",
        note = "GitHub default branch",
        rolling = true,
        checksum = main_checksum,
    })

    table.insert(result, {
        version = "local",
        note = "Local SUPERCTL_ROOT checkout",
        rolling = true,
        checksum = helper.get_local_checkout_checksum(),
    })

    for _, tag in ipairs(tags) do
        table.insert(result, {
            version = tag,
        })
    end

    return result
end
