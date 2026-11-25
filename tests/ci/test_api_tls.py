"""The API client keeps TLS verification when Python's default trust store is empty."""

import ssl
import unittest
from unittest.mock import patch

from providers.api.client import ApiClient


class ApiTlsTest(unittest.TestCase):
    def test_non_frozen_runtime_adds_ca_bundle_to_the_verified_context(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        self.assertEqual(context.get_ca_certs(), [])
        with patch("providers.api.client.ssl.create_default_context", return_value=context):
            ApiClient("http://fixture.invalid")
        self.assertTrue(context.get_ca_certs())
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
