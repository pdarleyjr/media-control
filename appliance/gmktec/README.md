# GMKtec boot recovery

Production Docker stores its complete data root under
`/mnt/mbfd-storage/docker-data`. Install the systemd drop-in before relying on
automatic container recovery:

```bash
sudo install -d -m 0755 /etc/systemd/system/docker.service.d
sudo install -m 0644 appliance/gmktec/docker.service.d/10-mbfd-storage.conf \
  /etc/systemd/system/docker.service.d/10-mbfd-storage.conf
sudo systemctl daemon-reload
systemctl show docker.service -p Requires -p Wants -p After
```

The drop-in does not restart Docker when installed. It takes effect on the next
Docker start and prevents the daemon from opening an empty root-disk mountpoint
before the 22 TB filesystem is available.

Rollback:

```bash
sudo rm /etc/systemd/system/docker.service.d/10-mbfd-storage.conf
sudo systemctl daemon-reload
```
