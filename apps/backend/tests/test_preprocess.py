import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('preprocess',Path(__file__).resolve().parents[1]/'scripts/catalog_preprocess.py')
preprocess=importlib.util.module_from_spec(spec)
spec.loader.exec_module(preprocess)

class SubtitleBounds(unittest.TestCase):
    def test_container_tail_does_not_create_phantom_video(self):
        text='1\n00:00:08,000 --> 00:00:13,000\n最后一句\n\n2\n00:00:15,000 --> 00:00:25,000\n拖长容器的字幕\n'
        cues,rejected=preprocess.subtitles(text,10)
        self.assertEqual(cues,[{'id':'cue-0000','start':8.,'end':10,'text':'最后一句'}])
        self.assertEqual(len(rejected),1)
    def test_same_source_subtitles_preserve_offsets_and_multiline_text(self):
        text='1\n00:00:01,250 --> 00:00:02,750\n<b>小圆</b>\n帰ろう\n'
        cues,rejected=preprocess.subtitles(text,10)
        self.assertEqual((cues[0]['start'],cues[0]['end']),(1.25,2.75))
        self.assertEqual(cues[0]['text'],'小圆 帰ろう')
        self.assertEqual(rejected,[])

if __name__=='__main__':unittest.main()
