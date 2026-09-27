import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
spec=importlib.util.spec_from_file_location('syncer',Path(__file__).resolve().parents[1]/'tools/sync-workspace.py');sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)

class SyncTests(unittest.TestCase):
    def test_public_showcase_media_is_an_exact_allowlist(self):
        from sync_workspace_policy import forbidden_path
        self.assertTrue(sync.permitted('pitch/showcase/sayaka-wings.mp4'))
        self.assertFalse(sync.permitted('pitch/showcase/raw-episode.mp4'))
        self.assertFalse(forbidden_path('docs/pitch/showcase/homura-fate.mp4'))
        self.assertTrue(forbidden_path('docs/pitch/showcase/raw-episode.mp4'))
    def test_release_allows_only_named_changelog_source_data(self):
        from sync_workspace_policy import forbidden_path
        for name in ['changelog.json','changelog-types.ts']:
            self.assertFalse(forbidden_path('apps/editor/src/data/'+name))
        for name in ['apps/editor/src/data/private.json','data/changelog.json','apps/backend/data/changelog.json']:
            self.assertTrue(forbidden_path(name))
    def test_scoped_sync_leaves_other_sources_and_prefix_neighbors_out(self):
        incoming={'docs/pitch/index.html':1,'docs/pitch-old/index.html':2,'apps/backend/new.mjs':3}
        baseline={'docs/pitch/removed.css':4,'apps/backend/old.mjs':5}
        selected,previous=sync.scoped_inputs(incoming,baseline,'docs/pitch')
        self.assertEqual(selected,{'docs/pitch/index.html':1})
        self.assertEqual(previous,{'docs/pitch/removed.css':4})
        with self.assertRaises(ValueError):sync.scoped_inputs(incoming,baseline,'../outside')
    def test_source_change_updates_clean_export(self):
        with tempfile.TemporaryDirectory(prefix='jev-sync-test-') as folder:
            root=Path(folder);(root/'code.js').write_bytes(b'old');base={'code.js':{'exportedHash':sync.digest(b'old')}};incoming={'code.js':({'exportedHash':sync.digest(b'new')},b'new')}
            updates,conflicts,kept=sync.changes(incoming,base,root);self.assertEqual(updates,[('code.js',b'new')]);self.assertFalse(conflicts)
    def test_release_only_edit_survives(self):
        with tempfile.TemporaryDirectory(prefix='jev-sync-test-') as folder:
            root=Path(folder);(root/'code.js').write_bytes(b'release patch');old=sync.digest(b'old');updates,conflicts,kept=sync.changes({'code.js':({'exportedHash':old},b'old')},{'code.js':{'exportedHash':old}},root);self.assertFalse(updates);self.assertFalse(conflicts);self.assertEqual(kept,['code.js'])
    def test_both_sides_changed_is_conflict(self):
        with tempfile.TemporaryDirectory(prefix='jev-sync-test-') as folder:
            root=Path(folder);(root/'code.js').write_bytes(b'release patch');updates,conflicts,_=sync.changes({'code.js':({'exportedHash':sync.digest(b'new')},b'new')},{'code.js':{'exportedHash':sync.digest(b'old')}},root);self.assertFalse(updates);self.assertEqual(conflicts,['code.js']);self.assertEqual((root/'code.js').read_bytes(),b'release patch')
    def test_deletion_does_not_erase_release_edits(self):
        with tempfile.TemporaryDirectory(prefix='jev-sync-test-') as folder:
            root=Path(folder);(root/'code.js').write_bytes(b'edited');updates,conflicts,_=sync.changes({},{'code.js':{'exportedHash':sync.digest(b'old')}},root);self.assertFalse(updates);self.assertEqual(conflicts,['code.js'])
    def test_private_assets_and_paths_excluded(self):
        for path in ['.local/state.json','localdevenv/.env','x/film.mp4','x/model.pth','node_modules/a.js','.env']:
            self.assertFalse(sync.permitted(path),path)
        self.assertTrue(sync.permitted('src/feature.tsx'))
        with self.assertRaises(ValueError):sync.destination(Path.cwd(),'../outside')
    def test_owned_files_not_managed(self):
        with tempfile.TemporaryDirectory(prefix='jev-sync-test-') as folder:
            root=Path(folder);(root/'README.md').write_text('owned');self.assertEqual(sync.changes({}, {}, root),([],[],[]));self.assertEqual((root/'README.md').read_text(),'owned')
    def test_release_menu_does_not_advertise_private_demo_projects(self):
        from release_adapt import adapt
        source=b"const defaults=[{id:'private-demo',name:'Demo'}];\nexport async function productionMenu(){return defaults;}\n"
        exported=adapt('apps/backend/production-menu.mjs',source).decode()
        self.assertIn('const defaults=[];',exported)
        self.assertNotIn('private-demo',exported)
        self.assertIn('return defaults;',exported)
        with self.assertRaisesRegex(ValueError,'menu defaults changed'):
            adapt('apps/backend/production-menu.mjs',b'const renamed=[];')
if __name__=='__main__':unittest.main()
