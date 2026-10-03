from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from unittest import mock

from hermes_plugin.presence_publisher import publisher
from hermes_plugin.presence_publisher.publisher import (
    event_for_hook,
    get_current_profile,
    identity,
    reset_profile,
    reset_room_id,
    resolve_room_id,
    sanitize_room_id,
    set_current_profile,
)


class HookMappingTests(unittest.TestCase):
    def test_maps_native_hooks_to_supported_collector_events(self):
        self.assertEqual(event_for_hook('pre_gateway_dispatch', event=object()), ('gateway', 'received'))
        self.assertEqual(event_for_hook('pre_llm_call'), ('llm', 'started'))
        self.assertEqual(event_for_hook('post_llm_call'), ('llm', 'completed'))
        self.assertEqual(event_for_hook('pre_tool_call'), ('tool', 'started'))
        self.assertEqual(event_for_hook('post_tool_call', status='error'), ('tool', 'failed'))
        self.assertEqual(event_for_hook('post_tool_call', status='success'), ('tool', 'completed'))


class IdentityTests(unittest.TestCase):
    def setUp(self):
        reset_room_id()
        reset_profile()

    def tearDown(self):
        reset_room_id()
        reset_profile()

    def test_defaults_follow_active_profile(self):
        with mock.patch.dict(os.environ, {'HERMES_HOME': '/Users/x/.hermes/profiles/atlas'}, clear=True):
            found = identity()
        self.assertEqual(found['botId'], 'atlas')
        self.assertEqual(found['hostId'], 'default')
        self.assertEqual(found['roomId'], 'direct')
        self.assertEqual(found['pet'], {'slug': 'atlas', 'version': '1.0.0', 'url': '/pets/atlas-v1.png'})
        self.assertTrue(found['hostId'])

    def test_identity_uses_hermes_constants_home_override(self):
        class FakeHermesConstants:
            _override = None

            @classmethod
            def set_hermes_home_override(cls, path):
                cls._override = path

            @classmethod
            def get_hermes_home(cls):
                return cls._override or os.getenv('HERMES_HOME', '/Users/x/.hermes')

        with mock.patch.dict(os.environ, {'HERMES_HOME': '/Users/x/.hermes'}, clear=True), \
                mock.patch.dict('sys.modules', {'hermes_constants': FakeHermesConstants}):
            FakeHermesConstants.set_hermes_home_override('/Users/x/.hermes/profiles/elio')
            found = identity()
            self.assertEqual(found['botId'], 'elio')
            self.assertEqual(found['pet']['slug'], 'elio')
            self.assertEqual(found['pet']['url'], '/pets/elio-v1.png')

    def test_explicit_environment_overrides_defaults(self):
        env = {
            'HERMES_HOME': '/Users/x/.hermes/profiles/atlas',
            'PRESENCE_HOST_ID': 'studio-mini-7',
            'PRESENCE_ROOM_ID': 'night-shift',
            'PRESENCE_BOT_ID': 'atlas-the-conductor',
            'PRESENCE_PET_SLUG': 'orion',
            'PRESENCE_PET_VERSION': '2.3.4',
            'PRESENCE_PET_URL': '/pets/custom.png',
        }
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(identity(), {
                'hostId': 'studio-mini-7',
                'roomId': 'night-shift',
                'botId': 'atlas-the-conductor',
                'pet': {'slug': 'orion', 'version': '2.3.4', 'url': '/pets/custom.png'},
            })


class RoomResolutionTests(unittest.TestCase):
    def setUp(self):
        reset_room_id()
        reset_profile()

    def tearDown(self):
        reset_room_id()
        reset_profile()

    def test_sanitize_room_id_handles_various_formats(self):
        self.assertEqual(sanitize_room_id('reflection-night'), 'reflection-night')
        self.assertEqual(sanitize_room_id('#general'), 'general')
        self.assertEqual(sanitize_room_id('Hermes / #daily-checkin'), 'daily-checkin')
        self.assertEqual(sanitize_room_id('Hermes / #daily-checkin / Tanggal 14 sept / topic 123'), 'daily-checkin')
        self.assertEqual(sanitize_room_id('Build Mode & Triage'), 'build-mode-triage')
        self.assertEqual(sanitize_room_id(''), 'direct')

    def test_dm_resolves_to_direct(self):
        source = mock.Mock(chat_type='dm', chat_name='ryansetiawan')
        event = mock.Mock(source=source)
        self.assertEqual(resolve_room_id(event=event), 'direct')

        source_private = mock.Mock(chat_type='private', chat_name='operator')
        self.assertEqual(resolve_room_id(source=source_private), 'direct')

        dict_event = {'source': {'chat_type': 'dm', 'chat_name': 'alice'}}
        self.assertEqual(resolve_room_id(event=dict_event), 'direct')

    def test_group_channel_resolves_to_channel_name(self):
        source = mock.Mock(chat_type='channel', chat_name='reflection-night')
        event = mock.Mock(source=source)
        self.assertEqual(resolve_room_id(event=event), 'reflection-night')

        source_hash = mock.Mock(chat_type='channel', chat_name='#general')
        self.assertEqual(resolve_room_id(source=source_hash), 'general')

    def test_lookup_from_channel_directory(self):
        sample_directory = {
            'platforms': {
                'discord': [
                    {'id': '1540866850043469924', 'name': 'reflection-night', 'type': 'channel'},
                    {'id': '1549047063038263397:1549047063038263397', 'name': 'Hermes / #daily-checkin / thread', 'type': 'thread'},
                    {'id': '9999999999999999999', 'name': 'alice-dm', 'type': 'dm'},
                ]
            }
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            dir_file = Path(tmpdir) / 'channel_directory.json'
            dir_file.write_text(json.dumps(sample_directory), encoding='utf-8')
            with mock.patch.dict(os.environ, {'HERMES_HOME': tmpdir}, clear=True):
                source = mock.Mock(chat_type='group', chat_name=None, chat_id='1540866850043469924')
                self.assertEqual(resolve_room_id(source=source), 'reflection-night')

                source_thread = mock.Mock(chat_type='thread', chat_name=None, chat_id='1549047063038263397:1549047063038263397')
                self.assertEqual(resolve_room_id(source=source_thread), 'daily-checkin')

                source_dm_lookup = mock.Mock(chat_type=None, chat_name=None, chat_id='9999999999999999999')
                self.assertEqual(resolve_room_id(source=source_dm_lookup), 'direct')

    def test_env_override_takes_precedence(self):
        source = mock.Mock(chat_type='channel', chat_name='general')
        with mock.patch.dict(os.environ, {'PRESENCE_ROOM_ID': 'custom-override'}, clear=True):
            self.assertEqual(resolve_room_id(source=source), 'custom-override')
            self.assertEqual(identity()['roomId'], 'custom-override')

    def test_fallback_when_no_source_or_name(self):
        self.assertEqual(resolve_room_id(), 'direct')
        self.assertEqual(resolve_room_id(source=mock.Mock(chat_type=None, chat_name=None, chat_id=None, parent_chat_id=None)), 'direct')


class TurnContinuityTests(unittest.TestCase):
    def setUp(self):
        reset_room_id()
        reset_profile()

    def tearDown(self):
        reset_room_id()
        reset_profile()

    def test_maintains_room_id_continuity_across_turn_lifecycle(self):
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

        env = {'HERMES_HOME': '/tmp/profiles/clio'}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(publisher, '_ENDPOINT', f'http://127.0.0.1:{server.server_port}/observe'):
            # 1. Inbound dispatch from reflection-night channel
            channel_source = mock.Mock(chat_type='channel', chat_name='reflection-night')
            channel_event = mock.Mock(source=channel_source)
            publisher.publish('pre_gateway_dispatch', event=channel_event)

            # 2. Subsequent turn hooks without event parameter
            publisher.publish('pre_llm_call')
            publisher.publish('pre_tool_call', tool_name='web_search')
            publisher.publish('post_tool_call', tool_name='web_search', status='success')
            publisher.publish('post_llm_call')

            publisher._QUEUE.join()

            # Verify all events in the turn maintained 'reflection-night' roomId
            self.assertEqual(len(received), 5)
            for event in received:
                self.assertEqual(event['roomId'], 'reflection-night')
                self.assertEqual(event['botId'], 'clio')

            # 3. Next turn arrives as a DM
            dm_source = mock.Mock(chat_type='dm', chat_name='user123')
            dm_event = mock.Mock(source=dm_source)
            publisher.publish('pre_gateway_dispatch', event=dm_event)
            publisher.publish('pre_llm_call')

            publisher._QUEUE.join()

        server.shutdown()
        server.server_close()

        self.assertEqual(len(received), 7)
        self.assertEqual(received[5]['roomId'], 'direct')
        self.assertEqual(received[6]['roomId'], 'direct')

    def test_maintains_profile_continuity_across_turn_lifecycle(self):
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

        env = {'HERMES_HOME': '/Users/x/.hermes'}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(publisher, '_ENDPOINT', f'http://127.0.0.1:{server.server_port}/observe'):
            # 1. Inbound dispatch for secondary profile 'elio' via source.profile
            elio_source = mock.Mock(chat_type='channel', chat_name='general', profile='elio')
            elio_event = mock.Mock(source=elio_source)
            publisher.publish('pre_gateway_dispatch', event=elio_event)

            # 2. Subsequent turn hooks without profile parameter
            publisher.publish('pre_llm_call')
            publisher.publish('pre_tool_call', tool_name='web_search')
            publisher.publish('post_llm_call')

            publisher._QUEUE.join()

            self.assertEqual(len(received), 4)
            for event in received:
                self.assertEqual(event['botId'], 'elio')
                self.assertEqual(event['pet']['slug'], 'elio')

            # 3. Next turn arrives with direct profile='atlas' kwarg
            publisher.publish('pre_gateway_dispatch', profile='atlas')
            publisher.publish('pre_llm_call')

            publisher._QUEUE.join()

        server.shutdown()
        server.server_close()

        self.assertEqual(len(received), 6)
        self.assertEqual(received[4]['botId'], 'atlas')
        self.assertEqual(received[5]['botId'], 'atlas')


class PublishTests(unittest.TestCase):
    def setUp(self):
        reset_room_id()
        reset_profile()

    def tearDown(self):
        reset_room_id()
        reset_profile()

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
        server.server_close()

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
