from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from threading import Thread
import unittest
from unittest import mock

from hermes_plugin.presence_publisher import publisher
from hermes_plugin.presence_publisher.publisher import event_for_hook, identity


class HookMappingTests(unittest.TestCase):
    def test_maps_native_hooks_to_supported_collector_events(self):
        self.assertEqual(event_for_hook('pre_gateway_dispatch', event=object()), ('gateway', 'received'))
        self.assertEqual(event_for_hook('pre_llm_call'), ('llm', 'started'))
        self.assertEqual(event_for_hook('post_llm_call'), ('llm', 'completed'))
        self.assertEqual(event_for_hook('pre_tool_call'), ('tool', 'started'))
        self.assertEqual(event_for_hook('post_tool_call', status='error'), ('tool', 'failed'))
        self.assertEqual(event_for_hook('post_tool_call', status='success'), ('tool', 'completed'))


class IdentityTests(unittest.TestCase):
    def test_defaults_follow_active_profile(self):
        with mock.patch.dict(os.environ, {'HERMES_HOME': '/Users/x/.hermes/profiles/atlas'}, clear=True):
            found = identity()
        self.assertEqual(found['botId'], 'atlas')
        self.assertEqual(found['roomId'], 'build-room')
        self.assertEqual(found['pet'], {'slug': 'atlas', 'version': '1.0.0', 'url': '/pets/atlas-v1.png'})
        self.assertTrue(found['hostId'])

    def test_explicit_environment_overrides_defaults(self):
        env = {
            'HERMES_HOME': '/Users/x/.hermes/profiles/atlas',
            'PRESENCE_HOST_ID': 'studio-mini-7', 'PRESENCE_ROOM_ID': 'night-shift', 'PRESENCE_BOT_ID': 'atlas-the-conductor',
            'PRESENCE_PET_SLUG': 'orion', 'PRESENCE_PET_VERSION': '2.3.4', 'PRESENCE_PET_URL': '/pets/custom.png',
        }
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(identity(), {
                'hostId': 'studio-mini-7', 'roomId': 'night-shift', 'botId': 'atlas-the-conductor',
                'pet': {'slug': 'orion', 'version': '2.3.4', 'url': '/pets/custom.png'},
            })


class PublishTests(unittest.TestCase):
    def test_hook_posts_event_with_identity_to_collector(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers['content-length']))))
                self.send_response(202)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = HTTPServer(('127.0.0.1', 0), Handler)
        Thread(target=server.serve_forever, daemon=True).start()
        env = {'HERMES_HOME': '/tmp/profiles/vega', 'PRESENCE_BOT_ID': 'vega-the-engineer', 'PRESENCE_HOST_ID': 'h1'}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(publisher, '_ENDPOINT', f'http://127.0.0.1:{server.server_port}/observe'):
            publisher.publish('pre_tool_call', tool_name='terminal')
            publisher._QUEUE.join()
        server.shutdown()

        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]['botId'], 'vega-the-engineer')
        self.assertEqual(received[0]['hostId'], 'h1')
        self.assertEqual(received[0]['pet'], {'slug': 'vega', 'version': '1.0.0', 'url': '/pets/vega-v1.png'})
        self.assertEqual((received[0]['source'], received[0]['type'], received[0]['activity']), ('tool', 'started', 'Running terminal'))

    def test_publish_is_fail_open_when_collector_is_down(self):
        with mock.patch.object(publisher, '_ENDPOINT', 'http://127.0.0.1:9/observe'):
            publisher.publish('pre_llm_call')
            publisher._QUEUE.join()


if __name__ == '__main__':
    unittest.main()
