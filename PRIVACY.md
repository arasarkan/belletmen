# belletmen Gizlilik Politikası / Privacy Policy

*Son güncelleme / Last updated: 8 Kasım 2026*

## Türkçe

belletmen, Google Meet toplantılarında yoklama almaya yarayan açık kaynaklı bir Chrome eklentisidir. belletmen'in bir sunucusu yoktur. Geliştiriciler dahil hiç kimse eklentinin topladığı veriyi görmez.

**Hangi veriler işlenir?**
- Meet'te görünen katılımcı adları ile giriş ve çıkış saatleri.
- Kullanıcının girdiği toplantı adı.
- Kullanıcının tabloya kendisi yazdığı takım listesi (ad soyad, alt takım).
- Bağlanan Google hesabının e-posta adresi. Bu adres yalnızca kullanıcının tarayıcısında tutulur; "Bağlı: …" yazısı ve oturum yenileme için kullanılır.

**Hangi veriler işlenmez?**
- Katılımcıların e-posta adresleri ve profil fotoğrafları.
- Kamera, mikrofon ve ekran içeriği.
- Sohbet mesajları.

**Veri nerede saklanır?**
- Toplantı sırasında kullanıcının kendi tarayıcısında (`chrome.storage`).
- Toplantı bitince, kullanıcının kendi Google Drive'ında belletmen'in oluşturduğu Google Sheets tablosunda.
- Veri üçüncü taraflara gönderilmez, satılmaz ve reklam için kullanılmaz.

**Google izinleri**
- belletmen yalnızca `drive.file` iznini kullanır. Bu izin, eklentinin yalnızca kendi oluşturduğu tabloya erişmesine olanak tanır; Drive'daki diğer dosyalara erişilemez.
- `openid` ve `email` izinleri yalnızca bağlı hesabı tanımak için kullanılır.
- belletmen'in Google API'lerinden aldığı bilgilerin kullanımı, Sınırlı Kullanım (*Limited Use*) gereklilikleri dahil olmak üzere [Google API Hizmetleri Kullanıcı Verileri Politikası](https://developers.google.com/terms/api-services-user-data-policy)'na uygundur.

**Silme**
- Kurulum sayfasındaki **Bağlantıyı kes** düğmesi Google iznini geri alır.
- Eklentiyi kaldırmak tarayıcıdaki tüm veriyi siler.
- Tablo kullanıcının Drive'ındadır ve kullanıcı istediği zaman silebilir.

**İletişim:** Sorularınız için projenin [GitHub sayfasında](https://github.com/arasarkan/belletmen/issues) bir issue açabilirsiniz.

## English

belletmen is an open-source Chrome extension for taking attendance in Google Meet meetings. belletmen has no server. Nobody, including the developers, can see the data the extension collects.

**Data processed**
- Participant display names shown in Meet, with join and leave times.
- The meeting title entered by the user.
- The team roster the user types into the spreadsheet (name, sub-team).
- The email address of the connected Google account. It is stored only in the user's browser and is used to show "Connected: …" and to refresh the session.

**Data not processed**
- Participants' email addresses and profile photos.
- Camera, microphone and screen content.
- Chat messages.

**Where data is stored**
- During the meeting, in the user's own browser (`chrome.storage`).
- After the meeting, in a Google Sheets spreadsheet that belletmen creates in the user's own Google Drive.
- Data is not sent to third parties, is not sold, and is not used for advertising.

**Google permissions**
- belletmen uses only the `drive.file` scope. This scope lets the extension access only the spreadsheet it created; it cannot access any other Drive files.
- The `openid` and `email` scopes are used only to identify the connected account.
- belletmen's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

**Deletion**
- The **Disconnect** button on the setup page revokes the Google permission.
- Uninstalling the extension deletes all data stored in the browser.
- The spreadsheet lives in the user's Drive, and the user can delete it at any time.

**Contact:** Open an issue on the project's [GitHub page](https://github.com/arasarkan/belletmen/issues).
