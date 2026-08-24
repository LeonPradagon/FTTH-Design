# Penjelasan Koneksi Kabel FTTH

Dokumen ini menjelaskan cara membaca hubungan kabel pada desain FTTH dan
menjadi acuan saat user menanyakan kenapa dua ODP tidak memiliki kabel
langsung.

## Jenis kabel

### Kabel distribusi

Kabel distribusi menghubungkan ODC dengan ODP di dalam tree ODC yang sama:

```text
ODC 17 ── kabel distribusi ── ODP 17/01
```

Kabel ini ditampilkan sebagai garis distribusi pada peta. Generator
memprioritaskan kabel langsung `ODC → ODP` agar mapping dan tampilan mudah
dibaca. Hubungan `ODP → ODP` hanya dipakai sebagai fallback ketika ODC tidak
memiliki rute jalan langsung yang valid ke ODP tersebut.

### Kabel feeder

Kabel feeder menghubungkan POP/OLT dengan ODC, atau menghubungkan ODC ke ODC
berikutnya dalam rantai feeder:

```text
POP/OLT ── feeder ── ODC 17 ── feeder ── ODC 08
```

Karena itu, hubungan lintas ODC tidak dibuat sebagai kabel distribusi langsung
antar-ODP.

## Contoh `ODP 17/01` dan `ODP 08/03`

Kedua label tersebut berada pada tree yang berbeda. Jika kebutuhan user adalah
memastikan keduanya berada dalam satu jalur jaringan, gunakan rantai feeder:

```text
ODP 08/03
    │ kabel distribusi
    ▼
ODC 08
    │ feeder chain: ODC 08 → ODC 09 → ... → ODC 17
    ▼
ODC 17
    │ kabel distribusi
    ▼
ODP 17/01
```

Jadi kabel yang diharapkan adalah:

- kabel distribusi `ODC 08 → ODP 08/03`;
- feeder chain dari `ODC 08` sampai `ODC 17`;
- kabel distribusi `ODC 17 → ODP 17/01`.

Tidak ada kabel distribusi langsung `ODP 17/01 → ODP 08/03` karena keduanya
berada di ODC yang berbeda.

Perlu diperhatikan bahwa nama `17/01` dan `08/03` dapat muncul lagi pada
batch atau ODC lain. Saat melakukan pengecekan, lihat folder ODC induknya,
bukan label ODP saja.

## Jika user ingin keduanya tersambung

Gunakan salah satu pendekatan berikut:

1. **Pendekatan FTTH yang direkomendasikan:** pastikan feeder chain dari ODC
   pertama sampai ODC tujuan tersedia dan toggle **Kabel Feeder** aktif di
   sidebar. Pada contoh ini, periksa rantai `ODC 08 → ... → ODC 17`.
2. **Pendekatan alternatif:** masukkan kedua ODP ke ODC yang sama. Ini mengubah
   pembagian kapasitas dan struktur jaringan, sehingga tidak boleh dilakukan
   hanya untuk membuat garis langsung di peta.

## Parameter konfigurasi

- `max_distribution_length_m`: batas validasi panjang kabel distribusi ODC →
  ODP.
- `max_feeder_length_m`: batas validasi panjang kabel feeder POP/ODC → ODC.
- `odc_capacity`: jumlah maksimum ODP yang dilayani satu ODC.
- `odp_capacity`: jumlah maksimum rumah yang dilayani satu ODP.

Nilai `max_distribution_length_m` ikut disimpan bersama Network Core. Jadi
**Regenerate Cables** memakai batas yang sama dengan saat desain dibuat dan
tidak menganggap rute valid sebagai error hanya karena konfigurasi berubah.

Parameter panjang tidak mengubah jenis koneksi. Jika kabel antar-ODC tidak
terlihat, periksa feeder dan lakukan **Regenerate Cables**; jangan menaikkan
`max_distribution_length_m` untuk memaksa kabel langsung antar-ODP.

## Custom mapping ODC–ODP

Untuk mengunci parent ODC secara manual, gunakan nama dengan nomor group yang
sama pada file KML custom:

```text
ODC 17
ODP 17/01
ODP 17/02

ODC 08
ODP 08/01
ODP 08/03
```

Format `ODC 17` dengan `ODP 17/01` akan diprioritaskan oleh generator. ODP
tidak lagi dipindahkan ke ODC terdekat hanya karena jarak geografisnya. Jika
nama tidak memiliki nomor group, generator masih menggunakan ODC terdekat
sebagai fallback kompatibilitas.

## Pemeriksaan konektivitas saat generate

Generator sekarang menjalankan pemeriksaan setelah routing:

- POP/OLT dapat dikenali dari nama Placemark, nama Folder, atau description;
- rute kabel pertama dicoba pada jaringan jalan OSM;
- jika gagal hanya karena graph OSM menerapkan jalan satu arah, generator
  mencoba ulang pada graph jalan dua arah. Geometrinya tetap mengikuti jalan;
- jika parent ODC menghasilkan detour yang melewati batas panjang distribusi,
  seluruh mapping ODP–ODC untuk desain kecil/menengah dioptimalkan ulang
  berdasarkan panjang rute jalan. Kapasitas ODC tetap dijaga, sehingga ODP
  tidak hanya dipindahkan ke ODC terdekat yang ternyata sudah penuh;
- untuk desain besar pencarian dimulai dari kandidat ODC terdekat agar tetap
  efisien, lalu otomatis diperluas ke semua ODC jika rute lokal gagal atau
  melewati batas panjang distribusi;
- jika ODP masih tidak memiliki rute jalan yang valid, generate dihentikan dan
  daftar ODP yang bermasalah ditampilkan. Kabel lurus tidak dibuat otomatis
  karena dapat memotong bangunan/perumahan.
- cache lama yang memiliki ODP tetapi menyimpan parent ODC yang buruk akan
  diperbaiki terlebih dahulu menggunakan jarak jalan aktual. Pertukaran parent
  tetap mematuhi kapasitas ODC, sehingga ODP tidak dibiarkan tanpa kabel hanya
  karena hasil clustering lama.
- setiap **Regenerate Cables** juga mengevaluasi ulang parent ODC berdasarkan
  road graph. Posisi titik tetap, tetapi ODP boleh dipindahkan ke ODC yang
  memiliki rute jalan valid dan kapasitas yang masih sesuai.

Dengan begitu, hasil tidak lagi terlihat berhasil padahal sebagian ODP diam-
diam tidak memiliki kabel. Perbaiki posisi ODC/ODP agar menempel pada jalan
kendaraan yang sama, lalu jalankan generate atau **Regenerate Cables** lagi.
Versi algoritma routing dinaikkan agar **Generate Design** tidak memakai
Network Core cache lama yang dibuat sebelum perbaikan ini.

## Checklist troubleshooting

1. Pastikan layer **design** terlihat.
2. Pastikan **Kabel Distribusi** dan **Kabel Feeder** aktif.
3. Buka folder ODC pada sidebar untuk memastikan ODP berada di tree yang
   benar.
4. Jalankan **Regenerate Cables** setelah perubahan generator/routing.
5. Jika tetap tidak ada, periksa warning routing OSM: kabel hanya dibuat jika
   rute jalan yang valid tersedia; sistem tidak boleh menggambar kabel lurus
   melewati area perumahan.
