module.exports = {
    content: ['./index.html', './app.js'],
    theme: {
        extend: {
            fontFamily: {
                sans: ['Vazirmatn', 'system-ui', 'sans-serif'],
            },
            colors: {
                brand: {
                    50: '#eef2ff',
                    100: '#e0e7ff',
                    500: '#6366f1',
                    600: '#4f46e5',
                    700: '#4338ca',
                    900: '#312e81',
                },
                'slate-850': '#141d2f',
                'slate-750': '#2b3648',
            },
        },
    },
    plugins: [],
};
