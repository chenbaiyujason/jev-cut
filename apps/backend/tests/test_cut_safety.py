import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('safe',Path(__file__).resolve().parents[1]/'scripts/refine_safe_ranges.py')
safe=importlib.util.module_from_spec(spec);spec.loader.exec_module(safe)

class Safety(unittest.TestCase):
    def test_remove_transition_band_and_padding_from_both_sides(self):
        ranges=safe.exclusion_ranges(0,100,[40,41,42],guard=2)
        self.assertEqual(ranges,[(3,38),(45,97)])
    def test_short_ranges_are_not_stretched_across_a_cut(self):
        self.assertEqual(safe.exclusion_ranges(0,8,[4]),[])

if __name__=='__main__':unittest.main()
