from pathlib import Path
import streamlit as st
import streamlit.components.v1 as components

# Configure page metadata and wide layout
st.set_page_config(
    page_title="SIMULAB // DC-3000 Test Bench",
    page_icon="⚡",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# Hide default Streamlit margins and navigation header for full immersion
st.markdown(
    """
    <style>
        #MainMenu {visibility: hidden;}
        footer {visibility: hidden;}
        header {visibility: hidden;}
        .block-container {
            padding: 0rem !important;
            max-width: 100% !important;
        }
    </style>
    """,
    unsafe_allow_html=True,
)


def load_application_bundle() -> str:
    base_dir = Path(__file__).parent
    html_content = (base_dir / "index.html").read_text(encoding="utf-8")

    # Inset CSS if external
    css_path = base_dir / "styles.css"
    if css_path.exists():
        css_content = css_path.read_text(encoding="utf-8")
        html_content = html_content.replace(
            '<link rel="stylesheet" href="styles.css">',
            f"<style>\n{css_content}\n</style>",
        )

    # Inset JS if external
    js_path = base_dir / "script.js"
    if js_path.exists():
        js_content = js_path.read_text(encoding="utf-8")
        html_content = html_content.replace(
            '<script src="script.js"></script>',
            f"<script>\n{js_content}\n</script>",
        )

    return html_content


# Render the interactive simulator
app_markup = load_application_bundle()
components.html(app_markup, height=1050, scrolling=True)