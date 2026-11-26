"""Project-scoped official HTTP client. Credentials never enter persisted config."""

from __future__ import annotations
import base64
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import http.cookiejar
import json
import ssl
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPCookieProcessor, HTTPSHandler, Request, build_opener
from .progress import request as request_progress


class ApiError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def server_url(value):
    if not isinstance(value, str):
        raise ApiError("API_CONFIG_INVALID", "项目地址必须是字符串")
    parts = urlsplit(value.strip())
    if (
        parts.scheme not in {"http", "https"}
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
    ):
        raise ApiError(
            "API_CONFIG_INVALID", "项目地址必须是无账号、查询参数或片段的 HTTP(S) 地址"
        )
    return value.strip().rstrip("/")


_READ_ENDPOINTS = {
    "/develop/vscode/source/download/" + name + ".htm"
    for name in (
        "getModulePages", "getModulePage", "getProcedures", "getProcFun",
        "getTables", "getTable", "getViews", "getView", "getSystemScripts",
        "getSystemScript", "getModuleTree", "getOtherConfig", "getSkills", "getNextPage",
    )
} | {
    "/develop/login/isLogin.htm",
    "/develop/systems/apps/developSystemList.htm",
    "/develop/systems/datasource/list.htm",
    "/develop/dev/models/config/getConfigs.htm",
    "/develop/dev/models/config/getConfig.htm",
    "/develop/dev/models/config/version/getCheckOutList.htm",
    "/develop/dev/pages/getPageModuleXml.htm",
    "/develop/dev/pages/getPageBaseInfo.htm",
}

_DEFAULT_HTTP_TIMEOUT = 120
_SOURCE_PULL_TIMEOUT = 300
_UNSPECIFIED_TIMEOUT = object()
_pulling_source = ContextVar("api_pulling_source", default=False)


@contextmanager
def source_pull_timeout():
    token = _pulling_source.set(True)
    try:
        yield
    finally:
        _pulling_source.reset(token)


class ApiClient:
    def __init__(self, root_url, *, opener=None, timeout=_UNSPECIFIED_TIMEOUT):
        self.root_url = server_url(root_url)
        if opener is None:
            context = ssl.create_default_context()
            try:
                import certifi
            except ModuleNotFoundError as error:
                # A standalone checkout can use the interpreter's default trust store.
                if error.name != "certifi":
                    raise
            else:
                context.load_verify_locations(cafile=certifi.where())
            self.opener = build_opener(
                HTTPCookieProcessor(http.cookiejar.CookieJar()),
                HTTPSHandler(context=context),
            )
        else:
            self.opener = opener
        if timeout is _UNSPECIFIED_TIMEOUT:
            self.timeout = _DEFAULT_HTTP_TIMEOUT
            self._source_pull_timeout = _SOURCE_PULL_TIMEOUT
        else:
            self.timeout = self._source_pull_timeout = timeout
        self.session = None
        self.access_token = None
        self.user = None
        self._session_auth = None

    def _connection_error(self, error, url):
        reason = error.reason if isinstance(error, URLError) else error
        target = (
            "当前项目平台"
            if urlsplit(url).netloc == urlsplit(self.root_url).netloc
            else "谷神登录服务"
        )
        if isinstance(reason, ssl.SSLCertVerificationError):
            return ApiError(
                "API_TLS_CERTIFICATE_ERROR",
                target + "的证书校验失败，请更新后端或检查系统受信任证书",
            )
        return ApiError(
            "API_CONNECTION_FAILED", "无法连接" + target + "，请核对地址和网络"
        )

    @property
    def has_session_credentials(self):
        return self._session_auth is not None

    def clear_session(self):
        self.session = None
        self.access_token = None
        self.user = None
        self._session_auth = None

    def logout(self):
        self.clear_session()
        for handler in getattr(self.opener, "handlers", ()):
            if isinstance(handler, HTTPCookieProcessor):
                handler.cookiejar.clear()

    def request(self, path, params=None, *, form=None, root=None):
        # Only known reads may recover and repeat after an explicit login-expired response.
        safe_read = path in _READ_ENDPOINTS
        try:
            return self._request_once(path, params, form=form, root=root)
        except ApiError as error:
            if (
                error.code != "API_LOGIN_REQUIRED"
                or not safe_read
                or root is not None
                or not self._session_auth
            ):
                raise
            user_id, password_hash = self._session_auth
            self._session_auth = None
            self._authenticate(user_id, password_hash)
            try:
                return self._request_once(path, params, form=form, root=root)
            except ApiError as repeated:
                if repeated.code == "API_LOGIN_REQUIRED":
                    self._session_auth = None
                raise

    def _request_once(self, path, params=None, *, form=None, root=None):
        with request_progress(path):
            url = (root or self.root_url) + path
            if params:
                url += "?" + urlencode(params)
            body = urlencode(form).encode() if form is not None else None
            request = Request(
                url,
                data=body,
                headers={
                    "Accept": "application/json",
                    "plugin-version": "1.0.10",
                    **(
                        {"Content-Type": "application/x-www-form-urlencoded"}
                        if body is not None
                        else {}
                    ),
                },
            )
            timeout = self._source_pull_timeout if _pulling_source.get() else self.timeout
            try:
                with self.opener.open(request, timeout=timeout) as response:
                    result = json.loads(response.read().decode("utf-8"))
            except HTTPError as error:
                raise ApiError(
                    "API_HTTP_ERROR", f"平台请求失败，HTTP {error.code}"
                ) from error
            except (URLError, TimeoutError, OSError) as error:
                raise self._connection_error(error, url) from error
            except (ValueError, UnicodeError) as error:
                raise ApiError("API_RESPONSE_INVALID", "平台未返回有效 JSON") from error
            if not isinstance(result, dict) or type(result.get("code")) is not int:
                raise ApiError("API_RESPONSE_INVALID", "平台应答缺少 code")
            if result["code"] != 0:
                if result["code"] == 2:
                    self.session = None
                    self.access_token = None
                    self.user = None
                raise ApiError(
                    "API_LOGIN_REQUIRED" if result["code"] == 2 else "API_REQUEST_FAILED",
                    str(result.get("message") or "平台请求失败"),
                )
            return result.get("data")

    def login(self, user_id, password, rand_code=""):
        self.clear_session()
        if (
            not isinstance(user_id, str)
            or not user_id.strip()
            or not isinstance(password, str)
            or not password
        ):
            raise ApiError("API_LOGIN_INVALID", "必须提供账号和密码，密码仅通过 stdin 传递")
        return self._authenticate(user_id, hashlib.md5(password.encode()).hexdigest().upper(), rand_code)

    def _authenticate(self, user_id, password_hash, rand_code=""):
        self.session = None
        self.access_token = None
        self.user = None
        init = self.request("/develop/login/getSystemInitVar.htm")
        cloud = server_url((init or {}).get("cloudpath") or "https://dev.guthon.com")
        sign = self.request("/develop/login/getTranSign.htm")
        if not isinstance(sign, dict):
            raise ApiError("API_RESPONSE_INVALID", "登录参数格式无效")
        signed = {
            **sign,
            "userId": user_id,
            "randCode": rand_code,
            "pwd": password_hash,
        }
        remote = self.request("/open/remote-login/doLogin.htm", form=signed, root=cloud)
        if not isinstance(remote, dict):
            raise ApiError("API_RESPONSE_INVALID", "云端登录应答格式无效")
        logged = self.request("/develop/login/doLoginInit.htm", form=remote)
        user = (logged or {}).get("user")
        if not isinstance(user, dict) or not user.get("tokenId"):
            raise ApiError("API_RESPONSE_INVALID", "登录应答缺少用户令牌")
        version = self.request("/develop/login/isLogin.htm")
        try:
            main = tuple(
                (list(int(x) for x in version["mainVersion"].split(".")) + [0, 0, 0])[
                    :3
                ]
            )
            date = int(version["dateVersion"])
        except (KeyError, ValueError, TypeError, AttributeError) as error:
            raise ApiError("API_VERSION_UNSUPPORTED", "平台未提供可核验版本") from error
        if main < (2, 0, 0) or date < 202611101305:
            raise ApiError(
                "API_VERSION_UNSUPPORTED",
                "源码 API 需要谷神 2.0.0 且日期版本不早于 202611101305",
            )
        self.access_token = user["tokenId"]
        self.user = {
            key: user[key] for key in ("userId", "userName", "loginId") if key in user
        }
        self.session = {
            "userId": user.get("userId"),
            "loginId": user_id,
            "userName": user.get("userName"),
            "mainVersion": version["mainVersion"],
            "dateVersion": str(version["dateVersion"]),
        }
        self._session_auth = (user_id, password_hash)
        return dict(self.session)

    def ensure_login(self):
        if self.session is None and self._session_auth:
            user_id, password_hash = self._session_auth
            self._session_auth = None
            self._authenticate(user_id, password_hash)
        if self.session is None:
            raise ApiError(
                "API_LOGIN_REQUIRED",
                "请在当前 Nexus 会话登录；独立 CLI 拉取可通过 stdin 同时提供账号密码",
            )

    def validate_session(self):
        self.ensure_login()
        version = self.request("/develop/login/isLogin.htm")
        if (
            not isinstance(version, dict)
            or not version.get("mainVersion")
            or not version.get("dateVersion")
        ):
            raise ApiError("API_RESPONSE_INVALID", "登录状态应答缺少平台版本")
        return dict(self.session)

    def captcha(self):
        init = self.request("/develop/login/getSystemInitVar.htm")
        cloud = server_url((init or {}).get("cloudpath") or "https://dev.guthon.com")
        request = Request(
            cloud + "/authimg.img?width=120&height=38",
            headers={"Accept": "image/png,image/jpeg,image/gif,image/webp"},
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                kind = response.headers.get_content_type()
                if kind not in {"image/png", "image/jpeg", "image/gif", "image/webp"}:
                    raise ApiError("API_CAPTCHA_INVALID", "验证码返回了不支持的图像")
                data = response.read(512 * 1024 + 1)
                if len(data) > 512 * 1024:
                    raise ApiError("API_CAPTCHA_INVALID", "验证码图像过大")
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            raise self._connection_error(error, request.full_url) from error
        return {"image": "data:" + kind + ";base64," + base64.b64encode(data).decode()}

    def designer_context(self):
        self.ensure_login()
        return {
            "rootUrl": self.root_url,
            "accessToken": self.access_token,
            "user": self.user,
            **{key: self.session[key] for key in ("mainVersion", "dateVersion")},
        }
