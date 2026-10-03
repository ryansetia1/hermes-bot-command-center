import unittest

from hermes_plugin.presence_publisher.publisher import event_for_hook


class HookMappingTests(unittest.TestCase):
    def test_maps_native_hooks_to_supported_collector_events(self):
        self.assertEqual(event_for_hook('pre_gateway_dispatch', event=object()), ('gateway', 'received'))
        self.assertEqual(event_for_hook('pre_llm_call'), ('llm', 'started'))
        self.assertEqual(event_for_hook('post_llm_call'), ('llm', 'completed'))
        self.assertEqual(event_for_hook('pre_tool_call'), ('tool', 'started'))
        self.assertEqual(event_for_hook('post_tool_call', status='error'), ('tool', 'failed'))
        self.assertEqual(event_for_hook('post_tool_call', status='success'), ('tool', 'completed'))


if __name__ == '__main__':
    unittest.main()
