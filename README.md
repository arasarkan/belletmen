# belletmen

Google Meet toplantılarında yoklama alan bir Chrome eklentisi. Toplantıdakileri izler, bitince yoklamayı Google Drive'ınızdaki bir tabloya yazar. Sunucu gerektirmez, ücretsizdir.

Bir FRC takımı olarak online toplantılarda yoklamayı elle alıyorduk. Bunu kolaylaştırmak için Claude ile yazdık. Hata görürseniz bir [issue](https://github.com/arasarkan/belletmen/issues) açarak bize bildirebilirsiniz.

## Kurulum

Eklenti Google'a giriş için bir Google Cloud istemcisi kullanıyor. Repodaki istemci bizim takımımıza ait ve yalnızca bizim eklediğimiz hesaplarla çalışıyor. Kendi takımınızda kullanmak için önce kendi istemcinizi oluşturmanız gerekiyor. Bu ücretsiz ve bir kez yapılıyor.

**Google Cloud**

1. [console.cloud.google.com](https://console.cloud.google.com) adresinde yeni bir proje açın ve **Google Sheets API**'yi etkinleştirin.
2. **Google Auth Platform**'da uygulama adını girin ve kitle olarak **Harici**'yi seçin. Veri erişimine `drive.file`, `openid` ve `email` izinlerini ekleyin.
3. **Kitle** bölümünde, yoklamayı alacak Google hesabını test kullanıcısı olarak ekleyin.
4. **İstemciler** bölümünde **Web uygulaması** türünde bir istemci oluşturun. Yönlendirme adresi olarak şunu girin:
   `https://kncnpbbglbifgljnijjoinnlkobfpgci.chromiumapp.org/oauth2`
5. Verilen istemci kimliğini `extension/config.js` dosyasına yazın.

**Eklenti**

1. Chrome'da `chrome://extensions` sayfasını açın, **Geliştirici modu**'nu açın.
2. **Paketlenmemiş öğe yükle** ile `extension` klasörünü seçin.
3. Açılan kurulum sayfasında Google hesabınızı bağlayın ve **Tablo oluştur**'a basın. Google "doğrulanmamış uygulama" uyarısı gösterirse devam edin; bu uyarı kendi istemcinizi henüz Google'a inceletmediğiniz için çıkar.
4. Tablodaki **Üyeler** sayfasına takım listesini yazın.

## Kullanım

Toplantıya katılın, Katılımcılar panelini açın ve eklentiden **Yoklamayı başlat**'a basın. Toplantı bitince **Bitir ve gönder**'e basın.

Eklenti Meet'teki adları takım listesiyle eşleştirir ve her üyeyi geldi, geç, kısmi ya da gelmedi olarak işaretler. Emin olamadığı adlar **İnceleme** sayfasına düşer. Oradan doğru kişiyi seçip eklentide **İncelemeyi uygula**'ya basarsanız, o ad bir dahaki sefere sorulmaz.

Kuralları (geç kalma süresi, minimum katılım) tablodaki **Ayarlar** sayfasından değiştirebilirsiniz. Mazeret için Yoklama sayfasında durumu `mazeretli` yapmanız yeterli.

## Gizlilik

Eklenti yalnızca Meet'te görünen adları ve giriş-çıkış saatlerini kaydeder. E-posta, fotoğraf ya da sohbet okumaz. Veri sadece sizin Drive'ınızdaki tabloya gider. Google'dan istenen izin (`drive.file`) yalnızca eklentinin kendi oluşturduğu tabloya erişim verir; Drive'daki diğer dosyalarınızı göremez. Ayrıntılar: [PRIVACY.md](PRIVACY.md).

## Sorun giderme

- **Eklenti Meet sekmesine bağlanamıyor:** Sekmeyi yenileyin.
- **Simgede kırmızı ünlem var:** Katılımcılar okunamıyor demektir. Katılımcılar panelini açın. Düzelmezse aşağıdaki gibi bildirin.

## Hata bildirimi

[Issues](https://github.com/arasarkan/belletmen/issues) sayfasından yeni bir issue açın. Ne olduğunu ve varsa hata mesajını yazın.

Sorun katılımcıların okunmasıyla ilgiliyse, kurulum sayfasında **Hata ayıklama modu**'nu açın. Sonra toplantıda eklentiden **Teşhis kopyala**'ya basıp çıktıyı issue'ya ekleyin. Bu çıktıda isimler gizlenir.

Issue'lara üyelerin gerçek adlarını eklemeyin.

## Geliştirme

Bağımlılık yok. Testleri çalıştırmak için:

```bash
npm test
```

Meet'in sayfa yapısıyla ilgili her şey `extension/selectors.js` dosyasında. Meet değişirse yalnızca bu dosyayı güncellemek gerekir.

## Lisans

MIT. Google ile bağlantısı yoktur.
