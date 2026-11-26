"""Check HTTP deadlines through the source pull commands."""

from io import BytesIO
import json
from unittest.mock import Mock, patch
from urllib.parse import parse_qsl, urlsplit

from providers.api import native_page
from providers.api.client import ApiClient, ApiError, source_pull_timeout
from providers.api.download import BASE
from test_api_pull import PullPlatform
from test_provider_regressions import WorkspaceCase


class ApiRequestTimeoutTest(WorkspaceCase):
    def test_pull_and_refresh_allow_slow_platform_responses(self):
        workspace = self.register("api")
        key = workspace["workspaceKey"]
        platform = PullPlatform()
        scope = {"systemIds": ["S1"], "dataSourceIds": ["D1"], "allSystems": False, "includeProjectFiles": False}
        self.tool("api", key=key, args=["configure"], payload={"serverUrl": platform.root_url, **scope})
        platform.pages = [{
            "pageId": "P1", "pageSubId": "1F", "pageType": 1, "fileName": "P1.xml", "versionMac": "v1",
            "xml": native_page.encode({"pageId": "P1", "title": "Fixture"}),
        }]
        opener = Mock()

        def open_source(request, *, timeout):
            if timeout < 135:
                raise TimeoutError("simulated source request took 135 seconds")
            url = urlsplit(request.full_url)
            endpoint = url.path.removeprefix(urlsplit(platform.root_url).path)
            params = dict(parse_qsl(url.query)) or None
            form = dict(parse_qsl(request.data.decode(), keep_blank_values=True)) if request.data else None
            data = platform.request(endpoint, params, form=form)
            return BytesIO(json.dumps({"code": 0, "data": data}).encode())

        opener.open.side_effect = open_source
        client = ApiClient(platform.root_url, opener=opener)
        client.session = {}
        with (
            patch("providers.api.cli.client_for", return_value=client),
            patch("providers.api.sync.client_for", return_value=client),
        ):
            for action, payload in (
                ("pull", {}),
                ("scope-apply", {"settings": scope}),
                ("refresh", {"prefix": "systems/S1/pages"}),
            ):
                with self.subTest(action=action):
                    opener.reset_mock()
                    platform.requests.clear()
                    result = self.tool("api", key=key, args=[action], payload=payload)
                    self.assertTrue(result["downloadComplete"])
                    self.assertIn((BASE + "getModuleTree.htm", None), platform.requests)
                    if action != "refresh":
                        self.assertIn((BASE + "getNextPage.htm", {"guid": "fixture-next"}), platform.requests)
                    self.assertEqual({call.kwargs["timeout"] for call in opener.open.call_args_list}, {300})

        opener.open.side_effect = None
        opener.open.return_value = BytesIO(b'{"code":0,"data":{}}')
        client.request("/develop/login/isLogin.htm")
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 120)

    def test_explicit_timeout_controls_page_export_without_retry(self):
        opener = Mock()
        opener.open.side_effect = TimeoutError("simulated timeout")
        client = ApiClient("https://fixture.invalid", opener=opener, timeout=10)

        with source_pull_timeout(), self.assertRaises(ApiError) as failure:
            client.request(BASE + "getModulePages.htm", {"systemId": "S1"})

        self.assertEqual(failure.exception.code, "API_CONNECTION_FAILED")
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 10)
