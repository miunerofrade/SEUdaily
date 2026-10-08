"""School-specific routes and application IDs; edit here when upstream moves."""

from urllib.parse import quote

AUTH_ROOT = "https://auth.seu.edu.cn/auth/casback"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
EHALL_ROOT = "https://ehall.seu.edu.cn"
PLAN_API_ROOT = EHALL_ROOT + "/jwapp/sys"
DEFAULT_PLAN_APP_ID = "4766859113956613"
DEFAULT_PLAN_LAUNCH_URL = EHALL_ROOT + f"/appShow?appId={DEFAULT_PLAN_APP_ID}"
PLAN_APP_PATH = "/jwapp/sys/xsfacx/"
PLAN_ENDPOINTS = {
    "grpyfacx": "/xsfacx/modules/pyfacxepg/grpyfacx.do",
    "qxpyfacx": "/jwpubapp/modules/pyfa/qxpyfacx.do",
    "kzcx": "/jwpubapp/modules/pyfa/kzcx.do",
    "kzkccx": "/jwpubapp/modules/pyfa/kzkccx.do",
}
DEFAULT_SCHEDULE_APP_ID = "4770397878132218"
DEFAULT_SCHEDULE_LAUNCH_URL = EHALL_ROOT + f"/appShow?appId={DEFAULT_SCHEDULE_APP_ID}"
DEFAULT_SCHEDULE_URL = EHALL_ROOT + "/jwapp/sys/wdkb/*default/index.do"
SCHEDULE_DATA_URL = EHALL_ROOT + "/jwapp/sys/wdkb/modules/xskcb/xskcb.do"
SCHEDULE_METADATA_ROOT = EHALL_ROOT + "/jwapp/sys/wdkb/modules/jshkcb/"

DEFAULT_PORTAL_URL = "https://cvs.seu.edu.cn"
BASE_URL = DEFAULT_PORTAL_URL + "/jy-application-resourcemanage"
UI_URL = DEFAULT_PORTAL_URL + "/jy-application-resourcemanage-ui/"
ENTRY_URL = (
    BASE_URL
    + "/oauth2/authorize?json=0&returnUri="
    + quote(UI_URL + "#/login?type=cas", safe="")
)
COURSE_ENDPOINTS = {
    "token": "/oauth2/token",
    "terms": "/v1/list/termYear",
    "courses": "/v1/group_subject_vod_list/t-1",
    "search": "/v1/union/vod_live_new",
    "lessons": "/v1/subject_vod_list_new",
    "play": "/v1/course_vod_urls_new",
    "subtitle": "/v1/course/ai/translate/{course_id}",
    "slides": "/v1/course/ai/ppt",
    "slides_pdf": "/v1/course/ai/ppt/download/pdf",
    "video": "/v1/getVodCourseVideo",
}
CALENDAR_URL = "https://jwc.seu.edu.cn/xl/list.htm"
