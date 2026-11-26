def fallback_instance(instances, name=None, path=None, emulator=None):
    """
    Pick the emulator instance to use when the configured serial matches none,
    for example after MuMu12 assigned the instance another port.

    Args:
        instances (list): Installed emulator instances, with `name`, `path` and `type`.
        name (str): Instance name saved in EmulatorInfo by an earlier successful run.
        path (str): Emulator executable saved in EmulatorInfo.
        emulator (str): Emulator type saved in EmulatorInfo.

    Returns:
        The only instance matching the saved info, or the only instance installed, or None.
    """
    instances = list(instances)
    if name and path:
        same = [i for i in instances if i.name == name and i.path == path]
        if emulator and len(same) > 1:
            same = [i for i in same if i.type == emulator]
        if len(same) == 1:
            return same[0]
    if len(instances) == 1:
        return instances[0]
    return None
