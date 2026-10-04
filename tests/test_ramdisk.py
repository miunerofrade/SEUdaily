import sys
from pathlib import Path

import pytest
from seudaily import ramdisk


def test_sizes():
    assert ramdisk.size_bytes('512M') == 512 * 1024**2
    assert ramdisk.size_bytes('1GiB') == 1024**3
    for value in ['-1G', '0', '1; echo bad', '4K', 'inf']:
        with pytest.raises(ValueError): ramdisk.size_bytes(value)


def test_mac_mount_rollback_detaches_allocated_device(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, 'platform', 'darwin')
    calls = []
    def run(*args):
        calls.append(args)
        if args[1] == 'attach': return '/dev/disk999'
        if args[0].endswith('newfs_hfs'): raise ramdisk.RamDiskError('format failed')
        return ''
    monkeypatch.setattr(ramdisk, '_run', run)
    disk = ramdisk.RamDisk('64M', mount_point=tmp_path / 'ram')
    with pytest.raises(ramdisk.RamDiskError): disk.mount()
    assert ('/usr/bin/hdiutil', 'detach', '/dev/disk999') in calls
    assert not disk.mounted and not (tmp_path / 'ram').exists()


def test_linux_options_and_unmount(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, 'platform', 'linux')
    calls = []
    monkeypatch.setattr(ramdisk, '_linux_run', lambda *args: calls.append(args) or '')
    disk = ramdisk.RamDisk('64M', mount_point=tmp_path / 'ram')
    disk.mount()
    assert calls[0][:3] == ('mount','-t','tmpfs')
    assert f'size={64*1024**2}' in calls[0][4]
    assert 'nosuid,nodev,noexec' in calls[0][4]
    disk.unmount()
    assert calls[-1][0] == 'umount'


def test_permission_failure_falls_back_to_isolated_disk_directory(monkeypatch):
    def fail(_self): raise ramdisk.RamDiskError('permission denied')
    monkeypatch.setattr(ramdisk.RamDisk, 'mount', fail)
    a = ramdisk.TemporaryWorkspace(use_ram=True)
    b = ramdisk.TemporaryWorkspace(use_ram=False)
    with pytest.warns(RuntimeWarning): first = a.open()
    second = b.open()
    assert first != second and a.fallback_reason
    a.close(); b.close()
    assert not first.exists() and not second.exists()


def test_existing_paths_are_never_formatted(monkeypatch,tmp_path):
    monkeypatch.setattr(sys,'platform','darwin')
    disk=ramdisk.RamDisk('64M',mount_point=tmp_path)
    with pytest.raises(ramdisk.RamDiskError): disk.mount()
    assert tmp_path.exists()


def test_shared_mount_refuses_unmount_until_media_finishes(tmp_path,monkeypatch):
    class Disk:
        mounted=True
        path=tmp_path
        def unmount(self): self.mounted=False
    disk=Disk();monkeypatch.setitem(ramdisk._disks,'R:',disk)
    workspace=ramdisk.TemporaryWorkspace(use_ram=False)
    path=workspace.open()
    assert path.parent == tmp_path
    assert ramdisk.remove_ramdisk()[0] is False
    workspace.close()
    assert ramdisk.remove_ramdisk()[0] is True


def test_cloud_cleanup_preserves_imported_user_audio(tmp_path):
    from seudaily.asr.cloud import CloudASRWorker
    audio=tmp_path/'original.wav';audio.write_bytes(b'original')
    worker=CloudASRWorker({},tmp_path)
    worker.temp_audio_path=str(audio)
    worker._cleanup()
    assert audio.read_bytes()==b'original'


def test_linux_sudo_is_noninteractive_and_missing_sudo_fails(monkeypatch):
    monkeypatch.setattr(ramdisk.os, 'geteuid', lambda: 1000)
    monkeypatch.setattr(ramdisk.shutil, 'which', lambda _: '/usr/bin/sudo')
    calls=[]
    monkeypatch.setattr(ramdisk, '_run', lambda *args: calls.append(args) or '')
    ramdisk._linux_run('mount','-t','tmpfs')
    assert calls[0][:2] == ('sudo','-n')
    monkeypatch.setattr(ramdisk.shutil, 'which', lambda _: None)
    with pytest.raises(ramdisk.RamDiskError,match='root'):ramdisk._linux_run('mount')


def test_linux_unmount_failure_preserves_owned_mount_for_retry(monkeypatch,tmp_path):
    monkeypatch.setattr(sys,'platform','linux')
    monkeypatch.setattr(ramdisk,'_linux_run',lambda *args:'')
    disk=ramdisk.RamDisk('64M',mount_point=tmp_path/'ram');disk.mount()
    def fail(*args):raise ramdisk.RamDiskError('busy')
    monkeypatch.setattr(ramdisk,'_linux_run',fail)
    with pytest.raises(ramdisk.RamDiskError):disk.unmount()
    assert disk.mounted and disk.path.exists()
    monkeypatch.setattr(ramdisk,'_linux_run',lambda *args:'');disk.unmount()


@pytest.mark.parametrize('platform,expected',[('darwin',('/usr/bin/open','-R')),('linux',('xdg-open',))])
def test_reveal_uses_system_handler_with_separate_path_argument(monkeypatch,tmp_path,platform,expected):
    monkeypatch.setattr(sys,'platform',platform)
    monkeypatch.setattr(ramdisk,'ramdisk_status',lambda:{'mounted':True,'path':str(tmp_path)})
    monkeypatch.setattr(ramdisk.shutil,'which',lambda _:'/usr/bin/xdg-open')
    calls=[];monkeypatch.setattr(ramdisk,'_run',lambda *args:calls.append(args) or '')
    assert ramdisk.reveal_ramdisk()['status']=='completed'
    assert calls[0][:-1]==expected and calls[0][-1]==str(tmp_path.resolve())


def test_reveal_rejects_unmounted_disk(monkeypatch):
    monkeypatch.setattr(ramdisk,'ramdisk_status',lambda:{'mounted':False,'path':None})
    with pytest.raises(ramdisk.RamDiskError):ramdisk.reveal_ramdisk()
