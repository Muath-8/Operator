export const paypalCopy = {
  en: {
    brand: 'Launch Operator',
    title: 'Try PayPal sandbox',
    back: 'Back to your mission',
    label: 'Local testing · PayPal sandbox',
    intro:
      'Practice a sample purchase with a real PayPal sandbox checkout. The demo amount is USD 1.00 in test money. Your local mission decisions use simulation; this page separately tests the real PayPal connection.',
    ready: 'Sandbox credentials are configured. Use a PayPal sandbox personal buyer account to approve the order.',
    missing:
      'Add your PayPal sandbox app client ID and client secret to .env.local-testing, then restart the local app. No credentials are needed to explore the rest of the app.',
    create: 'Approve USD 1.00 sandbox checkout',
    capture: 'Confirm USD 1.00 sandbox capture',
    busy: 'Checking with PayPal',
    returned:
      'You returned from PayPal. Confirm below to check approval and capture the test payment. Returning alone is not proof of payment.',
    cancelled: 'You cancelled checkout. This page has not requested a capture.',
    failed: 'The sandbox operation could not be confirmed. Check your setup and retry. No successful payment is claimed.',
    receipt: 'PayPal sandbox result',
    order: 'Order',
    captureId: 'Capture',
    status: 'Status',
    amount: 'Amount',
    note: 'This test does not move live money or create a production mission payment. A completed capture must come from PayPal; simulated decisions are never counted as receipts.',
  },
  ar: {
    brand: 'Launch Operator',
    title: 'جرّب بيئة باي بال التجريبية',
    back: 'العودة إلى مهمتك',
    label: 'اختبار محلي · بيئة باي بال التجريبية',
    intro:
      'جرّب شراء عينة من خلال اتصال فعلي ببيئة باي بال التجريبية. المبلغ دولار أمريكي واحد بأموال اختبار. قرارات المهمة المحلية محاكاة، وتختبر هذه الصفحة اتصال باي بال بشكل منفصل.',
    ready: 'بيانات الاتصال التجريبية معدّة. استخدم حساب مشتري شخصي تجريبي في باي بال للموافقة على الطلب.',
    missing:
      'أضف معرّف تطبيق باي بال التجريبي وسرّه إلى ملف إعدادات الاختبار المحلي، ثم أعد تشغيل التطبيق. يمكنك استكشاف باقي التطبيق دون بيانات اتصال.',
    create: 'الموافقة على دفع دولار تجريبي',
    capture: 'تأكيد تحصيل دولار تجريبي',
    busy: 'جارٍ التحقق مع باي بال',
    returned: 'عدت من باي بال. أكّد أدناه للتحقق من الموافقة وتحصيل مبلغ الاختبار. العودة وحدها ليست دليلاً على الدفع.',
    cancelled: 'ألغيت عملية الدفع. لم تطلب هذه الصفحة تحصيل المبلغ.',
    failed: 'تعذر تأكيد العملية التجريبية. تحقّق من الإعدادات وأعد المحاولة. لا نعتبر الدفع ناجحاً.',
    receipt: 'نتيجة باي بال التجريبية',
    order: 'الطلب',
    captureId: 'التحصيل',
    status: 'الحالة',
    amount: 'المبلغ',
    note: 'هذا الاختبار لا ينقل أموالاً حقيقية ولا يسجل دفعة في مهمة الإنتاج. تأكيد التحصيل يجب أن يأتي من باي بال؛ لا تُحسب قرارات المحاكاة كإيصالات.',
  },
} as const;
export type PayPalCopy = { [K in keyof typeof paypalCopy.en]: string };
