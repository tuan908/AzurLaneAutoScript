class CampaignEnd(Exception):
    pass


class OilExhausted(Exception):
    pass


class OilMaxed(Exception):
    pass


class MapDetectionError(Exception):
    pass


class MapWalkError(Exception):
    pass


class MapEnemyMoved(Exception):
    pass


class CampaignNameError(Exception):
    pass


class ScriptError(Exception):
    # This is likely to be a mistake of developers, but sometimes a random issue
    pass


class ScriptEnd(Exception):
    pass


class GameStuckError(Exception):
    pass


class GameBugError(Exception):
    # An error has occurred in Azur Lane game client. Alas is unable to handle.
    # A restart should fix it.
    pass


class GameTooManyClickError(Exception):
    pass


class EmulatorNotRunningError(Exception):
    pass


class GameNotRunningError(Exception):
    pass


class GamePageUnknownError(Exception):
    pass


HUMAN_TAKEOVER_EXIT_CODE = 10
# The game could not log in (maintenance, an update, the login screen stuck).
# The control server starts the worker again later to check.
RETRY_LATER_EXIT_CODE = 11


class RequestHumanTakeover(Exception):
    # Request human takeover
    # Alas is unable to handle such error, probably because of wrong settings.
    pass


class EmulatorNotFound(RequestHumanTakeover):
    # No emulator matches the configured serial: a setup problem a restart cannot fix
    pass


class HardNotSatisfied(RequestHumanTakeover):
    pass
